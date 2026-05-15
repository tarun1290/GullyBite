'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import SectionError from '../../../../components/restaurant/analytics/SectionError';
import {
  getAdminTaxonomy,
  getCities,
  queryPersonas,
} from '../../../../api/admin';
import type {
  CityDoc,
  CustomerPersona,
  PersonaQueryParams,
  PersonaQueryResult,
  TagTaxonomy,
} from '../../../../types';

// LIMITATION: there is no admin endpoint for "areas within a city" tied
// to persona area_clusters, so we use the city doc's `areas` array if
// available; otherwise fall back to a free-text comma-separated input.

const PRICE_OPTIONS: Array<CustomerPersona['price_sensitivity']> = ['budget', 'mid', 'premium'];
const FREQ_OPTIONS: Array<CustomerPersona['order_frequency']> = ['daily', 'weekly', 'biweekly', 'monthly', 'lapsed', 'never'];
const VEG_OPTIONS: Array<CustomerPersona['veg_strictness']> = ['strict_veg', 'flexible_veg', 'omnivore'];
const STAGE_OPTIONS: Array<CustomerPersona['discovery_stage']> = ['never_active', 'captain_browser', 'converted', 'repeat_customer', 'loyal'];

const STAGE_LABEL: Record<CustomerPersona['discovery_stage'], string> = {
  never_active: 'Never',
  captain_browser: 'Browser',
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

const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-1 px-2 text-sm w-full';
const LBL_CLS = 'text-xs text-dim font-semibold uppercase tracking-wide block mb-1';

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
  return `${Math.floor(mo / 12)} yr ago`;
}

function CheckboxGroup<T extends string>({
  label,
  options,
  selected,
  onToggle,
  format,
}: {
  label: string;
  options: readonly T[];
  selected: T[];
  onToggle: (v: T) => void;
  format?: (v: T) => string;
}): ReactNode {
  return (
    <div className="mb-4">
      <div className={LBL_CLS}>{label}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const on = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onToggle(opt)}
              className={on ? 'btn-p btn-sm' : 'btn-g btn-sm'}
            >
              {format ? format(opt) : opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function PersonaQueryPage(): ReactNode {
  const [cities, setCities] = useState<CityDoc[]>([]);
  const [taxonomy, setTaxonomy] = useState<TagTaxonomy | null>(null);
  const [cityId, setCityId] = useState<string>('');
  const [cuisine, setCuisine] = useState<string>('');
  const [minScore, setMinScore] = useState<number>(30);
  const [price, setPrice] = useState<Array<CustomerPersona['price_sensitivity']>>([]);
  const [freq, setFreq] = useState<Array<CustomerPersona['order_frequency']>>([]);
  const [veg, setVeg] = useState<Array<CustomerPersona['veg_strictness']>>([]);
  const [stage, setStage] = useState<Array<CustomerPersona['discovery_stage']>>([]);
  const [areaInput, setAreaInput] = useState<string>('');
  const [selectedAreas, setSelectedAreas] = useState<string[]>([]);

  const [result, setResult] = useState<PersonaQueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    getCities().then((list) => setCities(Array.isArray(list) ? list : [])).catch(() => setCities([]));
    getAdminTaxonomy().then((t) => setTaxonomy(t || null)).catch(() => setTaxonomy(null));
  }, []);

  const cityAreas: string[] = useMemo(() => {
    if (!cityId) return [];
    const doc = cities.find((c) => c._id === cityId);
    return doc?.areas || [];
  }, [cities, cityId]);

  const toggle = <T extends string>(setter: (next: T[]) => void, current: T[], v: T) => {
    setter(current.includes(v) ? current.filter((x) => x !== v) : [...current, v]);
  };

  const runQuery = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // Areas: prefer chip-selected list if any; otherwise fall back to
      // the free-text comma-separated input (used when the city has no
      // canonical area list to pick from).
      const areas = selectedAreas.length
        ? selectedAreas
        : areaInput.split(',').map((s) => s.trim()).filter(Boolean);
      const params: PersonaQueryParams = {};
      if (cityId) params.city_id = cityId;
      if (cuisine.trim()) params.cuisine = cuisine.trim();
      if (minScore > 0) params.min_cuisine_score = minScore;
      if (price.length) params.price_sensitivity = price;
      if (freq.length) params.order_frequency = freq;
      if (veg.length) params.veg_strictness = veg;
      if (stage.length) params.discovery_stage = stage;
      if (areas.length) params.area = areas;
      const res = await queryPersonas(params);
      setResult(res);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Query failed');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [areaInput, cityId, cuisine, freq, minScore, price, selectedAreas, stage, veg]);

  return (
    <div id="pg-personas-query">
      <div className="grid grid-cols-[1fr_1.4fr] gap-4">
        <div className="card p-4">
          <h3 className="text-base mb-3">Audience filters</h3>

          <div className="mb-4">
            <label className={LBL_CLS}>City</label>
            <select value={cityId} onChange={(e) => { setCityId(e.target.value); setSelectedAreas([]); }} className={INPUT_CLS}>
              <option value="">Any city</option>
              {cities.map((c) => (
                <option key={c._id} value={c._id}>{c.display_name || c.name}</option>
              ))}
            </select>
          </div>

          <div className="mb-4">
            <label className={LBL_CLS}>Cuisine</label>
            {taxonomy && taxonomy.cuisine_primary?.length ? (
              <select value={cuisine} onChange={(e) => setCuisine(e.target.value)} className={INPUT_CLS}>
                <option value="">Any cuisine</option>
                {taxonomy.cuisine_primary.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={cuisine}
                onChange={(e) => setCuisine(e.target.value)}
                placeholder="e.g. biryani"
                className={INPUT_CLS}
              />
            )}
          </div>

          <div className="mb-4">
            <label className={LBL_CLS}>Min cuisine score: {minScore}</label>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="w-full"
            />
          </div>

          <CheckboxGroup<CustomerPersona['price_sensitivity']>
            label="Price sensitivity"
            options={PRICE_OPTIONS}
            selected={price}
            onToggle={(v) => toggle(setPrice, price, v)}
          />
          <CheckboxGroup<CustomerPersona['order_frequency']>
            label="Order frequency"
            options={FREQ_OPTIONS}
            selected={freq}
            onToggle={(v) => toggle(setFreq, freq, v)}
          />
          <CheckboxGroup<CustomerPersona['veg_strictness']>
            label="Veg strictness"
            options={VEG_OPTIONS}
            selected={veg}
            onToggle={(v) => toggle(setVeg, veg, v)}
            format={(v) => v.replace(/_/g, ' ')}
          />
          <CheckboxGroup<CustomerPersona['discovery_stage']>
            label="Discovery stage"
            options={STAGE_OPTIONS}
            selected={stage}
            onToggle={(v) => toggle(setStage, stage, v)}
            format={(v) => STAGE_LABEL[v]}
          />

          <div className="mb-4">
            <label className={LBL_CLS}>Areas</label>
            {cityAreas.length ? (
              <div className="flex flex-wrap gap-1.5">
                {cityAreas.map((a) => {
                  const on = selectedAreas.includes(a);
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setSelectedAreas(on ? selectedAreas.filter((x) => x !== a) : [...selectedAreas, a])}
                      className={on ? 'btn-p btn-sm' : 'btn-g btn-sm'}
                    >
                      {a}
                    </button>
                  );
                })}
              </div>
            ) : (
              <input
                type="text"
                value={areaInput}
                onChange={(e) => setAreaInput(e.target.value)}
                placeholder="comma-separated, e.g. Banjara Hills, Jubilee Hills"
                className={INPUT_CLS}
              />
            )}
          </div>

          <button
            type="button"
            className="btn-p btn-sm w-full"
            onClick={runQuery}
            disabled={loading}
          >
            {loading ? 'Querying…' : 'Preview audience'}
          </button>
        </div>

        <div className="card p-4">
          <h3 className="text-base mb-3">Result preview</h3>
          {err ? (
            <SectionError message={err} onRetry={runQuery} />
          ) : !result ? (
            <div className="text-dim">Set filters and press <span className="font-semibold">Preview audience</span>.</div>
          ) : (
            <div>
              <div className="mb-4">
                <div className="text-xs text-dim font-semibold uppercase tracking-wide">Estimated audience size</div>
                <div className="text-3xl font-bold">{result.count.toLocaleString('en-IN')}</div>
              </div>
              <div className="text-xs text-dim font-semibold uppercase tracking-wide mb-2">
                Sample ({result.sample.length})
              </div>
              {result.sample.length === 0 ? (
                <div className="text-dim text-sm">No matching customers</div>
              ) : (
                <div className="border border-rim rounded-md divide-y divide-rim">
                  {result.sample.map((row) => (
                    <div key={row.customer_id} className="p-3 flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="mono text-xs text-dim">{row.customer_id}</span>
                        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${STAGE_CLS[row.discovery_stage] || 'bg-slate-100 text-slate-700'}`}>
                          {STAGE_LABEL[row.discovery_stage] || row.discovery_stage}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-xs">
                        {row.top_cuisines.slice(0, 3).map((c) => (
                          <span key={c.cuisine} className="inline-block rounded-full px-2 py-0.5 bg-slate-100 text-slate-700">
                            {c.cuisine} · {Math.round(c.score)}
                          </span>
                        ))}
                      </div>
                      <div className="text-xs text-dim">Last active: {relativeTime(row.last_active_at)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
