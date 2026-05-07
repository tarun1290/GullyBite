'use client';

// Window-in-window popup that surfaces incoming PAID orders the moment
// the dashboard's 30s poll detects them — wherever the merchant is in
// the dashboard tree, they get a single full-detail surface to confirm
// or decline without navigating to /orders. Doesn't take over the
// screen (480px card, bottom-right) so the operator can still see the
// page behind it.
//
// Detection is local to this component: independently polls
// /api/restaurant/orders and feeds syncWithOrders() to the existing
// alarm hook. The orders page also feeds the hook from its own poll;
// both feeders dedupe via the hook's module-level lastSeenPendingIds
// set, so the alarm fires exactly once per new id regardless of which
// caller saw it first.
//
// Multi-order: a queue of pending ids; "Order N of M" indicator + a
// "Next →" button to cycle without acting. Confirm/Decline removes
// the current id from the queue (next poll would also remove it; the
// immediate removal just makes the UI responsive). When the queue
// empties, the component returns null.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  acceptOrder,
  declineOrder,
  getOrderById,
  getOrders,
  getStaffedBranches,
  updateOrderStatus,
} from '../../api/restaurant';
import { useNewOrderSound } from '../../hooks/useNewOrderSound';
import { useToast } from '../Toast';

const POLL_MS = 30000;

// Local types — defined from scratch (NOT extending Order or OrderItem)
// because both upstream interfaces carry `[k: string]: unknown` index
// signatures. Intersecting / Omit-ing those keeps the index signature,
// which collapses every field reading like `o.wa_phone` or `it.name`
// down to `unknown` and breaks JSX assignability. The shape below
// covers every field the popup actually reads.
interface PopupOrderItem {
  id?: string;
  product_id?: string;
  name?: string;
  item_name?: string;
  quantity?: number;
  qty?: number;
  size?: string;
  price_paise?: number;
  price_rs?: number | string;
  line_total_rs?: number | string;
  variant_value?: string;
}

interface PopupOrder {
  id?: string;
  order_number?: string;
  display_order_id?: string;
  status?: string;
  customer_name?: string;
  receiver_name?: string | null;
  wa_phone?: string;
  bsuid?: string;
  branch_id?: string;
  branch_name?: string;
  total_rs?: number | string | null;
  subtotal_rs?: number | string | null;
  delivery_fee_rs?: number | string | null;
  delivery_fee_total_rs?: number | string | null;
  delivery_address?: string | null;
  // The actual order doc carries `delivery_instructions` (set by
  // services/order.js). Spec mentions `instructions` /
  // `special_instructions` as alternative names — accept all three
  // here so a backend rename or a Flow-style ingestion path doesn't
  // silently drop the field.
  instructions?: string | null;
  special_instructions?: string | null;
  delivery_instructions?: string | null;
  items?: PopupOrderItem[];
  created_at?: string;
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function maskPhone(p?: string | null): string {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  if (digits.length < 4) return p;
  return `••••${digits.slice(-4)}`;
}

function customerLabel(o: PopupOrder | null): string {
  if (!o) return '';
  const name = o.customer_name || o.receiver_name || '';
  const phone = maskPhone(o.wa_phone);
  if (name && phone) return `${name} · ${phone}`;
  if (name) return name;
  if (phone) return phone;
  if (o.bsuid) return `${String(o.bsuid).slice(0, 12)}…`;
  return '—';
}

function formatRs(n: number | string | null | undefined): string {
  const v = parseFloat(String(n || 0));
  return Number.isFinite(v) ? `₹${v.toFixed(2)}` : '₹0.00';
}

export default function NewOrderPopup() {
  const { syncWithOrders, markOrderActioned, setStaffedBranches } = useNewOrderSound();

  // Populate the alarm hook's staffed-branch suppression set so the
  // popup's syncWithOrders feeder respects per-branch coverage even
  // when the user is on a non-orders dashboard page. The orders page
  // also fires this fetch — both targets the same module-level set,
  // so doubling up is idempotent. Failures fall back to "alarm fires
  // for every branch", which is the safe default.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getStaffedBranches();
        if (cancelled) return;
        setStaffedBranches(r.staffed_branch_ids || []);
      } catch {
        /* non-fatal */
      }
    })();
    return () => { cancelled = true; };
  }, [setStaffedBranches]);
  const { showToast } = useToast();

  // Queue of order ids in PAID state. Order is preserved across polls
  // — already-known ids keep their slot; newly-detected ones append.
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [currentIdx, setCurrentIdx] = useState<number>(0);
  // Full-detail fetch for the currently-shown id only; refetch on cycle.
  const [orderDetail, setOrderDetail] = useState<PopupOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  // Per-action busy lock — disables both buttons + Next while any API
  // call (accept/decline) is in flight to prevent double-fires.
  const [busy, setBusy] = useState<'confirm' | 'decline' | null>(null);

  // ── Polling: list pending PAID orders ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await getOrders({ limit: 60 });
        if (cancelled) return;
        const list = (Array.isArray(data) ? data : []) as Array<{ id?: string; status?: string; display_id?: string; order_number?: string | number }>;
        // Feed the alarm hook — same payload shape it accepts from the
        // orders page. Idempotent across multiple feeders. Cast to the
        // hook's SyncOrder type (which requires id+status non-optional);
        // the hook itself filters out malformed entries internally.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        syncWithOrders(list as any);
        const paid = list.filter((o) => o && o.id && o.status === 'PAID').map((o) => String(o.id));
        setPendingIds((prev) => {
          // Preserve previous order so the user isn't surprised by the
          // queue reshuffling between polls. Already-present ids stay
          // in place; brand-new ids append at the tail.
          const next = new Set(paid);
          const kept = prev.filter((id) => next.has(id));
          const added = paid.filter((id) => !prev.includes(id));
          return [...kept, ...added];
        });
      } catch {
        /* silent — next tick retries */
      }
    };
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [syncWithOrders]);

  // Keep currentIdx in range when the queue changes underneath us.
  useEffect(() => {
    if (pendingIds.length === 0) {
      if (currentIdx !== 0) setCurrentIdx(0);
      return;
    }
    if (currentIdx >= pendingIds.length) {
      setCurrentIdx(pendingIds.length - 1);
    }
  }, [pendingIds, currentIdx]);

  const currentId = pendingIds[currentIdx] || null;

  // ── Detail fetch for the currently-shown id ────────────────────
  // Same getOrderById call OrderDetailModal uses. Loading state is
  // shown inline inside the popup body rather than blocking the whole
  // popup, so the action buttons remain visible (still disabled until
  // the detail lands).
  useEffect(() => {
    if (!currentId) {
      setOrderDetail(null);
      setDetailLoading(false);
      return undefined;
    }
    let cancelled = false;
    setDetailLoading(true);
    setOrderDetail(null);
    getOrderById(currentId)
      .then((o) => { if (!cancelled) setOrderDetail(o as PopupOrder | null); })
      .catch(() => { if (!cancelled) setOrderDetail(null); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [currentId]);

  const removeFromQueue = useCallback((id: string) => {
    setPendingIds((prev) => prev.filter((p) => p !== id));
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!currentId || busy) return;
    setBusy('confirm');
    try {
      await acceptOrder(currentId);
      // Auto-advance CONFIRMED → PREPARING. Owner dashboard treats
      // CONFIRMED as a transient state; the kitchen view (staff app)
      // is the only surface that needs an explicit "Start prep" click.
      // Fire-and-forget: if this second call fails, the order is
      // already accepted (state engine has flipped to CONFIRMED),
      // so we don't block the popup close or surface an error toast.
      // A subsequent settlement-side reconciliation or manual nudge
      // can pick up any orders that got stuck in CONFIRMED.
      try {
        await updateOrderStatus(currentId, 'PREPARING');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[NewOrderPopup] auto-advance to PREPARING failed:', err);
      }
      markOrderActioned(currentId);
      removeFromQueue(currentId);
      showToast('Order confirmed ✓', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Could not confirm order', 'error');
    } finally {
      setBusy(null);
    }
  }, [currentId, busy, markOrderActioned, removeFromQueue, showToast]);

  const handleDecline = useCallback(async () => {
    if (!currentId || busy) return;
    // No browser-level confirm dialog here — the popup itself IS the
    // confirmation surface (full order detail + two distinct,
    // well-spaced action buttons). The OrderCard row-level decline
    // does still gate behind a confirm prompt because an accidental
    // click on the busy orders table is more likely.
    setBusy('decline');
    try {
      const res = await declineOrder(currentId);
      markOrderActioned(currentId);
      removeFromQueue(currentId);
      const refundNote = res?.refundId ? ` (refund ${res.refundId})` : '';
      showToast(`Order declined${refundNote}`, 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Could not decline order', 'error');
    } finally {
      setBusy(null);
    }
  }, [currentId, busy, markOrderActioned, removeFromQueue, showToast]);

  const handleNext = useCallback(() => {
    if (busy || pendingIds.length <= 1) return;
    setCurrentIdx((i) => (i + 1) % pendingIds.length);
  }, [busy, pendingIds.length]);

  const total = pendingIds.length;
  const positionLabel = useMemo(
    () => (total > 0 ? `Order ${currentIdx + 1} of ${total}` : ''),
    [currentIdx, total],
  );

  if (total === 0) return null;

  const o = orderDetail;
  const items = o?.items || [];
  // Per policy: never display legacy ZM-YYYYMMDD-NNNN to restaurant
  // users. Prefer `display_order_id`; fall back to a slice of the
  // internal id for old orders. `currentId` is the queue-cycle index
  // tracker — useful as the absolute last resort if neither is set.
  const orderRef = o?.display_order_id || (o?.id ? `#${o.id.slice(-6)}` : currentId);
  // Single instructions string sourced from whichever field the order
  // doc actually carries (see PopupOrder type for why all three names
  // are accepted). Trimmed empty values count as "no instructions".
  const instructionsText = (
    o?.instructions
    ?? o?.special_instructions
    ?? o?.delivery_instructions
    ?? ''
  );
  const hasInstructions = typeof instructionsText === 'string' && instructionsText.trim().length > 0;

  return (
    <>
      {/* Backdrop — dims the dashboard so the popup reads as a modal
          surface. Lower z-index than the popup. Non-dismissive: clicking
          here intentionally does nothing because the merchant must
          Confirm or Decline; cycling without action goes via "Next →". */}
      <div aria-hidden className="fixed inset-0 bg-black/40 z-9998" />
      <div
        role="dialog"
        aria-label="New order"
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-[480px] max-h-[90vh] z-9999 bg-surface border border-rim rounded-xl shadow-[0_20px_50px_-10px_rgba(15,23,42,0.35),0_6px_18px_rgba(15,23,42,0.2)] overflow-hidden flex flex-col"
      >
      {/* Header */}
      <div className="py-3 px-4 border-b border-rim flex items-center justify-between gap-[0.6rem] bg-[#fef3c7]">
        <div className="flex items-center gap-2 min-w-0">
          <span aria-hidden className="text-base">🔔</span>
          <strong className="text-[0.88rem] text-[#92400e]">New Order</strong>
          {total > 1 && (
            <span className="text-[0.72rem] text-[#92400e] opacity-85">· {positionLabel}</span>
          )}
        </div>
        {total > 1 && (
          <button
            type="button"
            onClick={handleNext}
            disabled={!!busy}
            className="bg-transparent border border-[#fde68a] text-[#92400e] py-[0.2rem] px-[0.55rem] rounded-md text-[0.74rem] cursor-pointer disabled:cursor-not-allowed"
            aria-label="Show next pending order"
          >
            Next →
          </button>
        )}
      </div>

      {/* Body */}
      <div className="py-[0.9rem] px-4 max-h-[60vh] overflow-y-auto text-[0.84rem]">
        {detailLoading || !o ? (
          <div className="p-[1.2rem] text-center text-dim">
            Loading order details…
          </div>
        ) : (
          <>
            <div className="flex justify-between gap-[0.6rem] mb-[0.6rem]">
              <div>
                <div className="font-bold">#{orderRef}</div>
                <div className="text-[0.72rem] text-dim">
                  {fmtTime(o.created_at)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[0.72rem] text-dim">{o.branch_name || ''}</div>
                <div className="text-[0.72rem] text-dim">{customerLabel(o)}</div>
              </div>
            </div>

            <div className="border-t border-dashed border-rim2 pt-[0.4rem] mb-[0.6rem]">
              <div className="flex justify-between text-[0.78rem]">
                <span className="text-dim">Subtotal</span>
                <span>{formatRs(o.subtotal_rs)}</span>
              </div>
              <div className="flex justify-between text-[0.78rem]">
                <span className="text-dim">Delivery</span>
                <span>{formatRs(o.delivery_fee_total_rs ?? o.delivery_fee_rs)}</span>
              </div>
              <div className="flex justify-between mt-[0.2rem] font-bold">
                <span>Total</span>
                <span>{formatRs(o.total_rs)}</span>
              </div>
            </div>

            {o.delivery_address ? (
              <div className="text-[0.74rem] text-dim mb-[0.6rem]">
                📍 {o.delivery_address}
              </div>
            ) : null}

            {/* Items list (after address, per spec). Receipt-row format:
                "[qty]x Item Name (size) ........... ₹price". The dotted
                leader is a flex spacer with a dotted bottom border —
                expands to fill horizontal slack between name and price. */}
            {items.length > 0 ? (
              <div className="mb-[0.6rem]">
                <div className="text-[0.72rem] text-dim mb-1">Items</div>
                {items.map((it, idx) => {
                  const name = it.item_name || it.name || '—';
                  const qty = Number(it.quantity || 1);
                  const linePriceRs = (it.line_total_rs != null ? it.line_total_rs : it.price_rs);
                  const priceVal = parseFloat(String(linePriceRs || 0));
                  return (
                    <div
                      key={(it as { id?: string }).id || idx}
                      className="flex items-end gap-[0.4rem] text-[0.82rem] py-[0.18rem]"
                    >
                      <span className="whitespace-nowrap">
                        <span className="text-dim">{qty}×</span>{' '}
                        <span className="font-medium">{name}</span>
                        {it.size ? <span className="text-dim">{` (${it.size})`}</span> : null}
                      </span>
                      <span aria-hidden className="flex-1 min-w-[0.4rem] border-b border-dotted border-rim2 mb-[0.32em]" />
                      <span className="whitespace-nowrap tabular-nums">
                        {Number.isFinite(priceVal) ? formatRs(priceVal) : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* Instructions row — conditional on a non-empty value
                across any of the three accepted field names. */}
            {hasInstructions ? (
              <div className="mb-[0.4rem] py-[0.45rem] px-[0.65rem] bg-[#fef3c7] border border-[#fde68a] rounded-md text-[0.78rem] text-[#92400e] flex gap-[0.45rem] items-start">
                <span aria-hidden>📝</span>
                <div>
                  <div className="font-semibold mb-[0.1rem]">Instructions</div>
                  <div className="whitespace-pre-wrap wrap-break-word">{instructionsText}</div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Actions */}
      <div className="py-[0.7rem] px-4 border-t border-rim flex gap-2">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!o || !!busy}
          className="flex-1 py-[0.55rem] px-[0.8rem] bg-green-600 text-white border-0 rounded-lg font-bold text-[0.84rem] cursor-pointer disabled:cursor-not-allowed disabled:opacity-70"
        >
          {busy === 'confirm' ? '…' : '✓ Confirm Order'}
        </button>
        <button
          type="button"
          onClick={handleDecline}
          disabled={!o || !!busy}
          className="flex-1 py-[0.55rem] px-[0.8rem] bg-transparent text-red-600 border-[1.5px] border-red-600 rounded-lg font-bold text-[0.84rem] cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === 'decline' ? '…' : '✗ Decline Order'}
        </button>
      </div>
    </div>
    </>
  );
}
