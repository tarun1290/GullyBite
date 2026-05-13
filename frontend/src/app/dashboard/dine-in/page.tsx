'use client';

// Dine-in QR check-in dashboard surface.
//
// Three stacked sections:
//   A) Branch selector + Enable toggle + wa.me deeplink QR code.
//   B) Points config form (points_per_visit, milestone_thresholds tag
//      input with strict-ascending invariant, points_expiry_days).
//   C) Recent visits table (paginated, masked phone, source chip).
//
// QR rendering uses qrcode.react's <QRCodeCanvas> — fully client-side,
// no external QR service or network round-trip. A hidden 600px canvas
// renders alongside the visible 240px one purely so the Download PNG
// button can call toDataURL() on a print-quality version without
// affecting the visible UI.

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { useRestaurant } from '../../../contexts/RestaurantContext';
import {
  getBranches,
  getDineInConfig,
  updateDineInConfig,
  getDineInVisits,
  manualCheckin,
} from '../../../api/restaurant';
import type { Branch, DineInConfig, DineInVisit } from '../../../types';

type MsgState = { kind: 'ok' | 'err'; text: string } | null;

const DEFAULT_CONFIG: DineInConfig = {
  points_per_visit: 10,
  milestone_thresholds: [50, 100, 200],
  points_expiry_days: 180,
  enabled: false,
};

// Strip any non-digit chars (leading +, spaces, dashes). The wa.me
// deeplink expects digits only.
function normaliseDigits(input: string | null | undefined): string {
  if (!input) return '';
  return String(input).replace(/\D/g, '');
}

// Mask helper — mirrors NewOrderPopup.maskPhone so the local-entry
// staff form can render a confirmation without leaking the full number.
function maskPhoneLocal(p?: string | null): string {
  if (!p) return '';
  const digits = normaliseDigits(p);
  if (digits.length < 4) return p;
  return `••••${digits.slice(-4)}`;
}

// Resolve the WhatsApp number the QR deeplink should target. Dine-in
// is a promotional surface, so this MUST be the marketing number, not
// the ordering number — sending a check-in to the ordering line would
// trip transactional-vs-marketing routing on the backend
// (getOutboundNumberId at services/whatsapp.js:829) and the customer's
// "DININ-..." reply would land on the wrong inbound handler.
//
// Returns '' when no marketing display phone is available; callers
// render a "configure in Settings" notice instead of falling back to
// the ordering number.
function resolveWaNumber(displayPhone?: string | null): string {
  const digits = normaliseDigits(displayPhone);
  return digits.length >= 8 ? digits : '';
}

function buildDeeplink(waNumber: string, branchSlug: string): string {
  return `https://wa.me/${waNumber}?text=${encodeURIComponent(`DININ-${branchSlug}`)}`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function sortAsc(arr: number[]): number[] {
  return Array.from(new Set(arr.filter((n) => Number.isFinite(n) && n >= 0))).sort((a, b) => a - b);
}

interface BranchPickerProps {
  branches: Branch[];
  selectedId: string;
  onChange: (id: string) => void;
}
function BranchPicker({ branches, selectedId, onChange }: BranchPickerProps) {
  if (branches.length <= 1) return null;
  return (
    <div className="flex items-center gap-2 mb-4">
      <label className="text-xs font-semibold text-dim uppercase tracking-wider">Branch</label>
      <select
        value={selectedId}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-xs"
      >
        {branches.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
    </div>
  );
}

interface SectionAProps {
  branch: Branch | null;
  config: DineInConfig | null;
  waNumber: string;
  marketingConfigured: boolean;
  savingToggle: boolean;
  onToggle: (next: boolean) => void;
  msg: MsgState;
}
function SectionA({ branch, config, waNumber, marketingConfigured, savingToggle, onToggle, msg }: SectionAProps) {
  const enabled = !!config?.enabled;
  const slug = branch?.branch_slug || '';
  const canQr = !!waNumber && !!slug;
  const deeplink = canQr ? buildDeeplink(waNumber, slug) : '';

  // Hidden high-res canvas paired with the visible 240px one so the
  // Download PNG button can produce a print-quality image via
  // toDataURL() without re-rendering or fetching anything.
  const hiResCanvasRef = useRef<HTMLCanvasElement | null>(null);

  function onDownload() {
    if (!canQr) return;
    const c = hiResCanvasRef.current;
    if (!c) return;
    const dataUrl = c.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `dine-in-qr-${slug}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="card">
      <div className="ch">
        <h3 className="m-0">QR Code & Enable</h3>
        <label className="tog ml-auto">
          <span className="text-sm text-dim">Dine-in check-in</span>
          <span className="tsl">
            <input
              type="checkbox"
              checked={enabled}
              disabled={savingToggle || !branch}
              onChange={(e) => onToggle(e.target.checked)}
            />
            <span className="tsl-track" />
          </span>
        </label>
      </div>
      <div className="cb">
        <div className="notice wa mb-4">
          <div className="notice-ico">📲</div>
          <div className="notice-body">
            <div className="text-sm font-semibold text-tx mb-1">How dine-in check-in works</div>
            <div className="text-sm text-dim">
              Customer scans the QR at the table → WhatsApp opens with{' '}
              <code className="mono">DININ-{slug || '<branch-slug>'}</code> pre-filled →{' '}
              they tap send → we log the visit, award points, and fire the dine-in journey if a milestone is hit.
            </div>
          </div>
        </div>

        {!marketingConfigured ? (
          <div className="notice warn">
            <div className="notice-ico">⚠️</div>
            <div className="notice-body">
              <div className="text-sm font-semibold text-tx mb-1">Marketing WhatsApp number not configured</div>
              <div className="text-sm text-dim">
                Configure your marketing WhatsApp number in Settings to enable Dine-in QR check-ins.
              </div>
            </div>
          </div>
        ) : !canQr ? (
          <div className="empty">
            <span className="ei">📵</span>
            <h3>QR unavailable</h3>
            <p>
              {!waNumber
                ? "The configured marketing number isn't among this restaurant's connected WABA accounts — re-save it from Settings."
                : 'This branch has no slug yet — save the branch from Settings to assign one.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <QRCodeCanvas
              value={deeplink}
              size={240}
              marginSize={2}
              level="M"
              aria-label={`Dine-in QR for ${branch?.name || 'branch'}`}
              className="rounded-md border border-rim bg-white"
            />
            {/* Hidden 600px canvas — exists only so onDownload() can
                call toDataURL() for a print-quality PNG without
                affecting the visible layout. */}
            <QRCodeCanvas
              ref={hiResCanvasRef}
              value={deeplink}
              size={600}
              marginSize={2}
              level="M"
              className="hidden"
              aria-hidden="true"
            />
            <div className="mono text-xs text-dim text-center break-all max-w-md">{deeplink}</div>
            <button type="button" className="btn-g btn-sm" onClick={onDownload}>
              ⬇ Download PNG
            </button>
          </div>
        )}

        {msg && (
          <div
            className={`mt-3 text-sm ${msg.kind === 'ok' ? 'text-wa' : 'text-red'}`}
          >
            {msg.text}
          </div>
        )}
      </div>
    </div>
  );
}

interface SectionBProps {
  config: DineInConfig | null;
  saving: boolean;
  onSave: (next: DineInConfig) => Promise<void>;
}
function SectionB({ config, saving, onSave }: SectionBProps) {
  const [pointsPerVisit, setPointsPerVisit] = useState<string>('');
  const [thresholds, setThresholds] = useState<number[]>([]);
  const [thresholdInput, setThresholdInput] = useState<string>('');
  const [expiryDays, setExpiryDays] = useState<string>('');
  const [msg, setMsg] = useState<MsgState>(null);

  // Hydrate form from incoming config whenever the selected branch's
  // config arrives. Keeping the inputs as strings (vs numbers) avoids
  // the controlled-empty-value flicker when the operator clears a field.
  useEffect(() => {
    if (!config) return;
    setPointsPerVisit(String(config.points_per_visit ?? ''));
    setThresholds(sortAsc(Array.isArray(config.milestone_thresholds) ? config.milestone_thresholds : []));
    setExpiryDays(String(config.points_expiry_days ?? ''));
  }, [config]);

  function addThreshold() {
    const n = Number(thresholdInput);
    if (!Number.isFinite(n) || n < 0) {
      setMsg({ kind: 'err', text: 'Threshold must be a non-negative number' });
      return;
    }
    setThresholds((prev) => sortAsc([...prev, n]));
    setThresholdInput('');
    setMsg(null);
  }

  function removeThreshold(value: number) {
    setThresholds((prev) => prev.filter((x) => x !== value));
  }

  function onThresholdKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addThreshold();
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);
    const ppv = Number(pointsPerVisit);
    const expiry = Number(expiryDays);
    if (!Number.isFinite(ppv) || ppv < 0) {
      setMsg({ kind: 'err', text: 'Points per visit must be a non-negative number' });
      return;
    }
    if (!Number.isFinite(expiry) || expiry < 0) {
      setMsg({ kind: 'err', text: 'Points expiry days must be a non-negative number' });
      return;
    }
    const sorted = sortAsc(thresholds);
    try {
      await onSave({
        points_per_visit: ppv,
        milestone_thresholds: sorted,
        points_expiry_days: expiry,
        enabled: !!config?.enabled,
      });
      setMsg({ kind: 'ok', text: 'Saved.' });
    } catch (err: unknown) {
      const e2 = err as { userMessage?: string; message?: string };
      setMsg({ kind: 'err', text: e2?.userMessage || e2?.message || 'Could not save config' });
    }
  }

  const disabled = !config;

  return (
    <form className="card" onSubmit={onSubmit}>
      <div className="ch"><h3 className="m-0">Points Configuration</h3></div>
      <div className="cb">
        <div className="fgrid">
          <div className="fg">
            <label htmlFor="ppv">Points per visit</label>
            <input
              id="ppv"
              type="number"
              min="0"
              step="1"
              value={pointsPerVisit}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setPointsPerVisit(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="fg">
            <label htmlFor="expiry">Points expire after (days)</label>
            <input
              id="expiry"
              type="number"
              min="0"
              step="1"
              value={expiryDays}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setExpiryDays(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="fg span2">
            <label htmlFor="thr-input">Milestone thresholds <small>(reward template fires when a balance crosses these)</small></label>
            <div className="flex flex-wrap items-center gap-2">
              {thresholds.length === 0 && (
                <span className="text-sm text-mute">No thresholds set</span>
              )}
              {thresholds.map((t) => (
                <span key={t} className="chip on inline-flex items-center gap-1.5">
                  {t}
                  <button
                    type="button"
                    aria-label={`Remove ${t}`}
                    className="text-current opacity-70 hover:opacity-100 cursor-pointer"
                    onClick={() => removeThreshold(t)}
                    disabled={disabled}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <input
                id="thr-input"
                type="number"
                min="0"
                step="1"
                placeholder="Add a threshold then press Enter"
                value={thresholdInput}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setThresholdInput(e.target.value)}
                onKeyDown={onThresholdKey}
                disabled={disabled}
                className="max-w-xs"
              />
              <button type="button" className="btn-g btn-sm" onClick={addThreshold} disabled={disabled}>
                Add
              </button>
            </div>
          </div>
        </div>

        {msg && (
          <div className={`mt-3 text-sm ${msg.kind === 'ok' ? 'text-wa' : 'text-red'}`}>{msg.text}</div>
        )}
      </div>
      <div className="cb flex justify-end gap-2 border-t border-rim">
        <button type="submit" className="btn-p btn-sm" disabled={disabled || saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}

interface SectionCProps {
  visits: DineInVisit[];
  total: number;
  page: number;
  pages: number;
  loading: boolean;
  err: string | null;
  onPage: (next: number) => void;
}
function SectionC({ visits, total, page, pages, loading, err, onPage }: SectionCProps) {
  return (
    <div className="card">
      <div className="ch">
        <h3 className="m-0">Recent Visits</h3>
        <span className="text-xs text-dim ml-auto">
          {total > 0 ? `${total} total` : ''}
        </span>
      </div>
      <div className="cb">
        {err ? (
          <div className="empty">
            <span className="ei">⚠️</span>
            <h3>Could not load visits</h3>
            <p>{err}</p>
          </div>
        ) : loading && visits.length === 0 ? (
          <div className="flex items-center gap-2 py-6 justify-center">
            <span className="spin" /> <span className="text-sm text-dim">Loading…</span>
          </div>
        ) : visits.length === 0 ? (
          <div className="empty">
            <span className="ei">🍽</span>
            <h3>No check-ins yet</h3>
            <p>When a customer scans the QR or staff records a manual visit, it’ll show up here.</p>
          </div>
        ) : (
          <>
            <div className="tbl tbl-card">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Visit #</th>
                    <th>Points</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {visits.map((v) => (
                    <tr key={v._id}>
                      <td data-label="Date">{fmtDate(v.created_at)}</td>
                      <td data-label="Customer">
                        <div className="flex flex-col">
                          <span>{v.customer_name || '—'}</span>
                          <span className="mono text-xs text-dim">
                            {v.customer_phone_masked || maskPhoneLocal(v.customer_id) || '—'}
                          </span>
                        </div>
                      </td>
                      <td data-label="Visit #">#{v.visit_number}</td>
                      <td data-label="Points">+{v.points_earned}</td>
                      <td data-label="Source">
                        <span className={`chip ${v.source === 'qr' ? 'on' : ''}`}>
                          {v.source.toUpperCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pages > 1 && (
              <div className="flex items-center justify-between gap-2 mt-3">
                <span className="text-xs text-dim">Page {page} of {pages}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-g btn-sm"
                    disabled={page <= 1 || loading}
                    onClick={() => onPage(page - 1)}
                  >
                    ← Prev
                  </button>
                  <button
                    type="button"
                    className="btn-g btn-sm"
                    disabled={page >= pages || loading}
                    onClick={() => onPage(page + 1)}
                  >
                    Next →
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface ManualCheckinCardProps {
  branch: Branch | null;
  onCheckedIn: () => void;
}
function ManualCheckinCard({ branch, onCheckedIn }: ManualCheckinCardProps) {
  const [phone, setPhone] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<MsgState>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!branch) return;
    const digits = normaliseDigits(phone);
    if (digits.length < 8) {
      setMsg({ kind: 'err', text: 'Enter a valid phone number' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await manualCheckin(digits, branch.id);
      const hit = res.milestone_hit != null
        ? ` · milestone ${res.milestone_hit} hit`
        : '';
      setMsg({
        kind: 'ok',
        text: `Checked in ${maskPhoneLocal(digits)} (visit #${res.visit_number}, balance ${res.points_balance})${hit}.`,
      });
      setPhone('');
      onCheckedIn();
    } catch (err: unknown) {
      const e2 = err as { userMessage?: string; message?: string };
      setMsg({ kind: 'err', text: e2?.userMessage || e2?.message || 'Check-in failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <div className="ch"><h3 className="m-0">Manual Check-in (Staff)</h3></div>
      <div className="cb">
        <div className="flex items-end gap-2 flex-wrap">
          <div className="fg flex-1 min-w-[200px]">
            <label htmlFor="manual-phone">Customer phone</label>
            <input
              id="manual-phone"
              type="tel"
              inputMode="numeric"
              placeholder="91XXXXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={!branch || busy}
            />
          </div>
          <button type="submit" className="btn-p btn-sm" disabled={!branch || busy}>
            {busy ? 'Recording…' : 'Record check-in'}
          </button>
        </div>
        {msg && (
          <div className={`mt-3 text-sm ${msg.kind === 'ok' ? 'text-wa' : 'text-red'}`}>{msg.text}</div>
        )}
      </div>
    </form>
  );
}

export default function DineInPage() {
  const { restaurant } = useRestaurant();

  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchesErr, setBranchesErr] = useState<string | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState<string>('');

  const [config, setConfig] = useState<DineInConfig | null>(null);
  const [configErr, setConfigErr] = useState<string | null>(null);
  const [savingToggle, setSavingToggle] = useState<boolean>(false);
  const [savingConfig, setSavingConfig] = useState<boolean>(false);
  const [toggleMsg, setToggleMsg] = useState<MsgState>(null);

  const [visits, setVisits] = useState<DineInVisit[]>([]);
  const [visitTotal, setVisitTotal] = useState<number>(0);
  const [visitPage, setVisitPage] = useState<number>(1);
  const [visitPages, setVisitPages] = useState<number>(1);
  const [visitsErr, setVisitsErr] = useState<string | null>(null);
  const [visitsLoading, setVisitsLoading] = useState<boolean>(false);

  const selectedBranch = useMemo<Branch | null>(
    () => branches.find((b) => b.id === selectedBranchId) || null,
    [branches, selectedBranchId],
  );

  // Pulls the joined marketing display phone from GET /api/restaurant
  // (server-resolved against waba_accounts by the
  // marketing_wa_phone_number_id). marketingConfigured tells us whether
  // the operator has saved a marketing number at all — used to switch
  // the empty state copy between "configure marketing number" (true
  // gap) and "branch slug missing" (different gap).
  const marketingConfigured = Boolean(restaurant?.marketing_wa_phone_number_id);
  const waNumber = useMemo<string>(
    () => resolveWaNumber(restaurant?.marketing_wa_display_phone),
    [restaurant?.marketing_wa_display_phone],
  );

  // Load branches once on mount. Default-select the first one with a
  // slug (the QR section is dead without one) — falls back to the
  // first branch if none have slugs yet so the rest of the surface
  // still hydrates.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getBranches();
        if (cancelled) return;
        setBranches(list);
        const withSlug = list.find((b) => !!b.branch_slug);
        setSelectedBranchId(withSlug?.id || list[0]?.id || '');
      } catch (err: unknown) {
        const e = err as { userMessage?: string; message?: string };
        if (!cancelled) setBranchesErr(e?.userMessage || e?.message || 'Could not load branches');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadConfig = useCallback(async () => {
    if (!selectedBranchId) return;
    setConfigErr(null);
    try {
      const res = await getDineInConfig(selectedBranchId);
      setConfig(res.dine_in_config || DEFAULT_CONFIG);
    } catch (err: unknown) {
      const e = err as { userMessage?: string; message?: string };
      setConfigErr(e?.userMessage || e?.message || 'Could not load config');
      setConfig(DEFAULT_CONFIG);
    }
  }, [selectedBranchId]);

  const loadVisits = useCallback(async (page: number) => {
    if (!selectedBranchId) return;
    setVisitsLoading(true);
    setVisitsErr(null);
    try {
      const res = await getDineInVisits(selectedBranchId, page);
      setVisits(res.visits);
      setVisitTotal(res.total);
      setVisitPage(res.page);
      setVisitPages(res.pages);
    } catch (err: unknown) {
      const e = err as { userMessage?: string; message?: string };
      setVisitsErr(e?.userMessage || e?.message || 'Could not load visits');
    } finally {
      setVisitsLoading(false);
    }
  }, [selectedBranchId]);

  useEffect(() => {
    if (!selectedBranchId) return;
    setVisitPage(1);
    loadConfig();
    loadVisits(1);
  }, [selectedBranchId, loadConfig, loadVisits]);

  async function onToggle(next: boolean) {
    if (!selectedBranchId || !config) return;
    setSavingToggle(true);
    setToggleMsg(null);
    try {
      const res = await updateDineInConfig(selectedBranchId, { enabled: next });
      setConfig(res.dine_in_config);
      setToggleMsg({ kind: 'ok', text: next ? 'Dine-in check-in enabled.' : 'Dine-in check-in disabled.' });
    } catch (err: unknown) {
      const e = err as { userMessage?: string; message?: string };
      setToggleMsg({ kind: 'err', text: e?.userMessage || e?.message || 'Could not update' });
    } finally {
      setSavingToggle(false);
    }
  }

  async function onSaveConfig(next: DineInConfig) {
    if (!selectedBranchId) return;
    setSavingConfig(true);
    try {
      const res = await updateDineInConfig(selectedBranchId, next);
      setConfig(res.dine_in_config);
    } finally {
      setSavingConfig(false);
    }
  }

  if (branchesErr) {
    return (
      <div className="empty">
        <span className="ei">⚠️</span>
        <h3>Could not load branches</h3>
        <p>{branchesErr}</p>
      </div>
    );
  }

  if (branches.length === 0) {
    return (
      <div className="empty">
        <span className="ei">🏪</span>
        <h3>No branches yet</h3>
        <p>Add a branch from Settings → Branches before configuring dine-in check-in.</p>
      </div>
    );
  }

  return (
    <div>
      <BranchPicker
        branches={branches}
        selectedId={selectedBranchId}
        onChange={setSelectedBranchId}
      />

      {configErr && (
        <div className="notice warn mb-4">
          <div className="notice-ico">⚠️</div>
          <div className="notice-body">
            <div className="text-sm text-tx">{configErr}</div>
          </div>
        </div>
      )}

      <SectionA
        branch={selectedBranch}
        config={config}
        waNumber={waNumber}
        marketingConfigured={marketingConfigured}
        savingToggle={savingToggle}
        onToggle={onToggle}
        msg={toggleMsg}
      />

      <ManualCheckinCard
        branch={selectedBranch}
        onCheckedIn={() => loadVisits(1)}
      />

      <SectionB
        config={config}
        saving={savingConfig}
        onSave={onSaveConfig}
      />

      <SectionC
        visits={visits}
        total={visitTotal}
        page={visitPage}
        pages={visitPages}
        loading={visitsLoading}
        err={visitsErr}
        onPage={(next) => loadVisits(next)}
      />
    </div>
  );
}
