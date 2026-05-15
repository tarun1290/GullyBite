'use client';

import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import SectionError from '../../../../components/restaurant/analytics/SectionError';
import { useToast } from '../../../../components/Toast';
import {
  getCustomerPersona,
  rebuildCustomerPersona,
} from '../../../../api/admin';
import type { CustomerPersona } from '../../../../types';

// LIMITATION: there is no first-class admin "find customer by phone"
// endpoint yet; we pass the raw input to the personas endpoint and let
// the backend resolve it (it accepts either customer_id or wa_phone).
// If we later add a lookup helper (e.g. getAdminCustomerIdentity by
// phone) we can resolve first and pass a canonical id.

interface CustomerHeader { id: string; name?: string; phone?: string }

const STAGE_LABEL: Record<CustomerPersona['discovery_stage'], string> = {
  never_active: 'Never active',
  captain_browser: 'Captain browser',
  converted: 'Converted',
  repeat_customer: 'Repeat',
  loyal: 'Loyal',
};

const STAGE_CLS: Record<CustomerPersona['discovery_stage'], string> = {
  never_active: 'bg-slate-200 text-slate-600',
  captain_browser: 'bg-slate-300 text-slate-800',
  converted: 'bg-blue-100 text-blue-700',
  repeat_customer: 'bg-teal-100 text-teal-700',
  loyal: 'bg-amber-100 text-amber-700',
};

const PRICE_LABEL: Record<CustomerPersona['price_sensitivity'], string> = {
  budget: 'Budget',
  mid: 'Mid',
  premium: 'Premium',
};

const VEG_LABEL: Record<CustomerPersona['veg_strictness'], string> = {
  strict_veg: 'Strict veg',
  flexible_veg: 'Flexible veg',
  omnivore: 'Omnivore',
};

const TIME_LABEL: Record<CustomerPersona['time_patterns'][number], string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  late_night: 'Late night',
};

function fmtRs(n: number | null | undefined): string {
  const v = Number(n || 0);
  try { return '₹' + v.toLocaleString('en-IN'); } catch { return '₹' + v; }
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'never';
  const diff = Date.now() - t;
  if (diff < 0) return 'in the future';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} mo${mo === 1 ? '' : 's'} ago`;
  const y = Math.floor(mo / 12);
  return `${y} yr${y === 1 ? '' : 's'} ago`;
}

const CHIP_CLS = 'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-700 mr-1.5 mb-1.5';

export default function PersonaInspectPage(): ReactNode {
  const { showToast } = useToast();
  const [input, setInput] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [rebuilding, setRebuilding] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [header, setHeader] = useState<CustomerHeader | null>(null);
  const [persona, setPersona] = useState<CustomerPersona | null>(null);

  const lookup = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await getCustomerPersona(q);
      setHeader(res.customer);
      setPersona(res.persona);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Lookup failed');
      setHeader(null);
      setPersona(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    lookup(input);
  };

  const onRebuild = useCallback(async () => {
    if (!header) return;
    setRebuilding(true);
    try {
      const next = await rebuildCustomerPersona(header.id);
      setPersona(next);
      showToast('Persona rebuilt', 'success');
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Rebuild failed', 'error');
    } finally {
      setRebuilding(false);
    }
  }, [header, showToast]);

  const topCuisines = persona
    ? Object.entries(persona.cuisine_affinity || {})
        .sort((a, b) => (b[1] || 0) - (a[1] || 0))
        .slice(0, 5)
    : [];

  return (
    <div id="pg-personas-inspect">
      <form
        onSubmit={onSubmit}
        className="flex gap-2 flex-wrap items-end mb-5 py-3 px-4 bg-neutral-0 border border-rim rounded-lg"
      >
        <div className="flex-1 min-w-[260px]">
          <label className="text-xs text-dim block mb-1">Customer phone or ID</label>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. 919812345678 or 64f1c3..."
            className="bg-neutral-0 border border-rim rounded-md py-1.5 px-2.5 text-sm w-full"
          />
        </div>
        <button type="submit" className="btn-p btn-sm" disabled={loading}>
          {loading ? 'Loading…' : 'Look up'}
        </button>
      </form>

      {err ? (
        <div className="mb-5"><SectionError message={err} onRetry={() => lookup(input)} /></div>
      ) : null}

      {header ? (
        <div className="card mb-5">
          <div className="ch flex items-center justify-between">
            <div>
              <h3 className="m-0">{header.name || header.phone || header.id}</h3>
              <div className="text-xs text-dim mt-1 mono">{header.id}</div>
            </div>
            <button
              type="button"
              className="btn-g btn-sm"
              onClick={onRebuild}
              disabled={rebuilding}
            >
              {rebuilding ? 'Rebuilding…' : 'Rebuild now'}
            </button>
          </div>
          <div className="cb">
            {!persona ? (
              <div className="text-dim">No persona yet for this customer. Click <span className="font-semibold">Rebuild now</span> to generate one.</div>
            ) : (
              <PersonaBody persona={persona} topCuisines={topCuisines} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface PersonaBodyProps {
  persona: CustomerPersona;
  topCuisines: Array<[string, number]>;
}

function PersonaBody({ persona, topCuisines }: PersonaBodyProps): ReactNode {
  const stageCls = STAGE_CLS[persona.discovery_stage] || 'bg-slate-100 text-slate-700';
  const engagement = Math.max(0, Math.min(100, Number(persona.engagement_score) || 0));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${stageCls}`}>
          {STAGE_LABEL[persona.discovery_stage]}
        </span>
        <span className={CHIP_CLS}>{PRICE_LABEL[persona.price_sensitivity]}</span>
        <span className={CHIP_CLS}>{VEG_LABEL[persona.veg_strictness]}</span>
        <span className="text-xs text-dim ml-auto">
          Last active: {relativeTime(persona.last_active_at)}
        </span>
      </div>

      <div className="grid grid-cols-[1fr_1fr] gap-4 mb-4">
        <div>
          <div className="text-xs text-dim font-semibold uppercase tracking-wide mb-2">Top cuisines</div>
          {topCuisines.length === 0 ? (
            <div className="text-dim text-sm">No cuisine data</div>
          ) : (
            topCuisines.map(([cuisine, raw]) => {
              const score = Math.max(0, Math.min(100, Number(raw) || 0));
              return (
                <div key={cuisine} className="mb-2">
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium">{cuisine}</span>
                    <span className="text-dim">{score.toFixed(0)}</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-md overflow-hidden">
                    <div
                      className="h-full bg-teal-600 rounded-md"
                      style={{ width: `${score}%` }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div>
          <div className="text-xs text-dim font-semibold uppercase tracking-wide mb-2">Engagement</div>
          <div className="text-2xl font-bold mb-1">{engagement.toFixed(0)}</div>
          <div className="h-2 bg-slate-100 rounded-md overflow-hidden mb-4">
            <div
              className="h-full bg-amber-500 rounded-md"
              style={{ width: `${engagement}%` }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-dim">CLTV</div>
              <div className="text-base font-semibold">{fmtRs(persona.customer_lifetime_value_rs)}</div>
            </div>
            <div>
              <div className="text-xs text-dim">Total orders</div>
              <div className="text-base font-semibold">{persona.total_orders}</div>
            </div>
            <div>
              <div className="text-xs text-dim">GBRef conversions</div>
              <div className="text-base font-semibold">{persona.gbref_conversion_count}</div>
            </div>
            <div>
              <div className="text-xs text-dim">Captain sessions</div>
              <div className="text-base font-semibold">{persona.total_captain_sessions}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="mb-3">
        <div className="text-xs text-dim font-semibold uppercase tracking-wide mb-2">Time patterns</div>
        {persona.time_patterns.length === 0 ? (
          <div className="text-dim text-sm">No patterns yet</div>
        ) : (
          persona.time_patterns.map((t) => (
            <span key={t} className={CHIP_CLS}>{TIME_LABEL[t] || t}</span>
          ))
        )}
      </div>

      <div className="mb-3">
        <div className="text-xs text-dim font-semibold uppercase tracking-wide mb-2">Area clusters</div>
        {persona.area_clusters.length === 0 ? (
          <div className="text-dim text-sm">No area clusters</div>
        ) : (
          persona.area_clusters.map((a) => <span key={a} className={CHIP_CLS}>{a}</span>)
        )}
      </div>

      <div className="text-xs text-dim mt-4">
        Schema v{persona.schema_version}
        {persona.recompute_at ? ` · recompute by ${relativeTime(persona.recompute_at)}` : ''}
      </div>
    </div>
  );
}
