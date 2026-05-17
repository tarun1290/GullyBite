'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useToast } from '../../Toast';
import { assignProductToBranch } from '../../../api/restaurant';
import type { Branch } from '../../../types';

interface AssignBranchModalProps {
  productId: string;
  productName: string;
  branches: Branch[];
  onClose: () => void;
  onSaved?: () => void;
}

export default function AssignBranchModal({ productId, productName, branches, onClose, onSaved }: AssignBranchModalProps) {
  const { showToast } = useToast();
  const [branchId, setBranchId] = useState<string>('');
  const [price, setPrice] = useState<string>('');
  const [tax, setTax] = useState<string>('');
  const [avail, setAvail] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // Esc cancels — never assigns (mirrors CostConfirmCard's window keydown
  // pattern: e.key === 'Escape', cleanup on unmount). Esc is intentionally
  // left out of the Tab trap so it always escapes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus management + manual Tab trap. Capture pre-mount focus owner,
  // focus the first focusable element, restore on unmount; Tab/Shift+Tab
  // wrap within the modal container.
  useEffect(() => {
    const active = document.activeElement;
    prevFocusRef.current = active instanceof HTMLElement ? active : null;
    const SEL = 'button,input,select,textarea,[tabindex]:not([tabindex="-1"]),a[href]';
    const focusables = (): HTMLElement[] =>
      Array.from(modalRef.current?.querySelectorAll<HTMLElement>(SEL) || [])
        .filter((el) => !el.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      const act = document.activeElement;
      if (e.shiftKey && act === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && act === last) { e.preventDefault(); first?.focus(); }
    };
    const node = modalRef.current;
    node?.addEventListener('keydown', onKey);
    return () => {
      node?.removeEventListener('keydown', onKey);
      prevFocusRef.current?.focus();
    };
  }, []);

  const handleSave = async () => {
    if (!branchId) return showToast('Pick a branch', 'error');
    const p = parseFloat(price);
    if (Number.isNaN(p) || p < 0) return showToast('Price is required', 'error');
    const t = parseFloat(tax);
    setBusy(true);
    try {
      await assignProductToBranch(productId, {
        branch_id: branchId,
        price: p,
        tax_percentage: Number.isNaN(t) ? undefined : t,
        availability: avail,
      });
      showToast('✅ Assigned to branch', 'success');
      if (onSaved) onSaved();
      if (onClose) onClose();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Assign failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const operational = (branches || []).filter((b) => b.is_active !== false);

  return (
    <div
      className="fixed inset-0 bg-black/50 z-100 flex items-start justify-center py-8 px-4"
      onClick={(e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={modalRef} role="dialog" aria-modal="true" className="card max-w-[480px] w-full bg-surface">
        <div className="ch justify-between">
          <h3>📌 Assign to Branch</h3>
          <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={busy}>✕</button>
        </div>
        <div className="cb">
          <p className="text-sm text-dim mb-3">
            Assigning <strong>{productName}</strong> to a branch. Set the per-branch price so customers
            at that outlet see the right amount.
          </p>
          <div className="fgrid">
            <div className="fg span2">
              <label>Branch *</label>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Select branch…</option>
                {operational.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.fssai_number ? '' : ' (no FSSAI)'}
                  </option>
                ))}
              </select>
            </div>
            <div className="fg">
              <label>Price (₹) *</label>
              <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div className="fg">
              <label>Tax % (optional)</label>
              <input type="number" value={tax} onChange={(e) => setTax(e.target.value)} />
            </div>
            <div className="fg span2">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={avail} onChange={(e) => setAvail(e.target.checked)} />
                Available at this branch
              </label>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button type="button" className="btn-p" onClick={handleSave} disabled={busy}>
              {busy ? 'Assigning…' : 'Assign'}
            </button>
            <button type="button" className="btn-g" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
