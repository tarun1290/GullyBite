'use client';

import type { ReactNode } from 'react';
import type { ChartData, ChartOptions } from 'chart.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import ChartCanvas from '../../../components/shared/ChartCanvas';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import { useToast } from '../../../components/Toast';
import { useAdminAuth } from '../../../contexts/AdminAuthContext';
import {
  getCities,
  getPersonaDistribution,
  rebuildPersonasBatch,
} from '../../../api/admin';
import type { CityDoc, PersonaDistribution } from '../../../types';

const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-1 px-2 text-sm';
const FILTER_LBL_CLS = 'text-xs text-dim block mb-1';

interface PersonaChartCardProps {
  title: string;
  bucketLabels: Record<string, string>;
  data: Record<string, number> | undefined;
  color: string;
}

function PersonaChartCard({ title, bucketLabels, data, color }: PersonaChartCardProps): ReactNode {
  const rows = useMemo(() => {
    if (!data) return [] as Array<[string, number]>;
    // Preserve the canonical bucket order from bucketLabels rather than
    // relying on object-property order in the API response.
    return Object.keys(bucketLabels).map((k) => [k, Number(data[k] || 0)] as [string, number]);
  }, [bucketLabels, data]);

  return (
    <div className="card p-4">
      <h3 className="text-base mb-2.5">{title}</h3>
      {!data ? (
        <div className="text-dim">Loading…</div>
      ) : (
        <ChartCanvas
          type="bar"
          height={220}
          data={{
            labels: rows.map(([k]) => bucketLabels[k] || k),
            datasets: [
              {
                label: title,
                data: rows.map(([, v]) => v),
                backgroundColor: color,
              },
            ],
          } satisfies ChartData<'bar'>}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              y: { beginAtZero: true, ticks: { precision: 0 } },
              x: { ticks: { font: { size: 10 } } },
            },
          } satisfies ChartOptions<'bar'>}
        />
      )}
    </div>
  );
}

const DISCOVERY_LABELS: Record<string, string> = {
  never_active: 'Never active',
  captain_browser: 'Captain browser',
  converted: 'Converted',
  repeat_customer: 'Repeat',
  loyal: 'Loyal',
};
const PRICE_LABELS: Record<string, string> = {
  budget: 'Budget',
  mid: 'Mid',
  premium: 'Premium',
};
const FREQ_LABELS: Record<string, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Biweekly',
  monthly: 'Monthly',
  lapsed: 'Lapsed',
  never: 'Never',
};
const VEG_LABELS: Record<string, string> = {
  strict_veg: 'Strict veg',
  flexible_veg: 'Flexible veg',
  omnivore: 'Omnivore',
};

export default function AdminPersonasPage(): ReactNode {
  const { adminUser } = useAdminAuth();
  const { showToast } = useToast();

  const [cities, setCities] = useState<CityDoc[]>([]);
  const [cityId, setCityId] = useState<string>('');
  const [dist, setDist] = useState<PersonaDistribution | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState<boolean>(false);

  useEffect(() => {
    getCities()
      .then((list) => setCities(Array.isArray(list) ? list : []))
      .catch(() => setCities([]));
  }, []);

  const load = useCallback(async () => {
    setErr(null);
    setDist(null);
    try {
      const d = await getPersonaDistribution(cityId || undefined);
      setDist(d);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed to load distribution');
    }
  }, [cityId]);

  useEffect(() => {
    load();
  }, [load]);

  const canRebuild = adminUser?.role === 'super_admin' || adminUser?.role === 'city_ops';

  const onRebuildAll = useCallback(async () => {
    const cityLabel = cities.find((c) => c._id === cityId)?.display_name
      || cities.find((c) => c._id === cityId)?.name
      || 'ALL cities';
    const msg = `Rebuild personas for ${cityLabel}? This may take a while.`;
    if (!window.confirm(msg)) return;
    setRebuilding(true);
    try {
      const res = await rebuildPersonasBatch(cityId ? { city_id: cityId } : {});
      showToast(`Queued ${res.queued} persona rebuilds`, 'success');
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Rebuild failed', 'error');
    } finally {
      setRebuilding(false);
    }
  }, [cities, cityId, showToast]);

  return (
    <div id="pg-personas">
      <div className="flex gap-2 flex-wrap items-end mb-5 py-3 px-4 bg-neutral-0 border border-rim rounded-lg">
        <div>
          <label className={FILTER_LBL_CLS}>City</label>
          <select
            value={cityId}
            onChange={(e) => setCityId(e.target.value)}
            className={INPUT_CLS}
          >
            <option value="">All Cities</option>
            {cities.map((c) => (
              <option key={c._id} value={c._id}>{c.display_name || c.name}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-2 ml-auto">
          <a href="/admin/personas/inspect" className="btn-g btn-sm">Inspect customer</a>
          <a href="/admin/personas/query" className="btn-g btn-sm">Audience query</a>
          {canRebuild ? (
            <button
              type="button"
              className="btn-p btn-sm"
              onClick={onRebuildAll}
              disabled={rebuilding}
            >
              {rebuilding ? 'Queuing…' : 'Rebuild all personas'}
            </button>
          ) : null}
        </div>
      </div>

      {err ? (
        <div className="mb-5"><SectionError message={err} onRetry={load} /></div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 mb-5">
        <PersonaChartCard
          title="Discovery stage"
          bucketLabels={DISCOVERY_LABELS}
          data={dist?.discovery_stage}
          color="rgba(15,118,110,.7)"
        />
        <PersonaChartCard
          title="Price sensitivity"
          bucketLabels={PRICE_LABELS}
          data={dist?.price_sensitivity}
          color="rgba(249,195,3,.7)"
        />
        <PersonaChartCard
          title="Order frequency"
          bucketLabels={FREQ_LABELS}
          data={dist?.order_frequency}
          color="rgba(228,38,35,.7)"
        />
        <PersonaChartCard
          title="Veg strictness"
          bucketLabels={VEG_LABELS}
          data={dist?.veg_strictness}
          color="rgba(13,95,60,.7)"
        />
      </div>
    </div>
  );
}
