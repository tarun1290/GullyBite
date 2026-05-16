'use client';

// Lifted verbatim from the (being-deleted) marketing-analytics page:
// `CustomerSection` + its `CustomerData/RfmRow/AcquisitionRow` shapes and the
// local helpers it relies on (`SectionCard`, `StatGrid`, `fmtNum`). Card and
// StatCard relative paths are identical from this directory, so kept as-is.

import { useEffect, useState, type ReactNode } from 'react';
import Card from '../../../components/Card';
import StatCard from '../../../components/StatCard';
import { getCustomerGrowth } from '../../../api/restaurant';

const PERIODS: ReadonlyArray<readonly [string, string]> = [
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];

function fmtNum(n: number | string | null | undefined): string {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-IN');
}

interface SectionCardProps {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  empty?: string | null;
  loading?: boolean;
}

function SectionCard({ title, subtitle, children, empty, loading }: SectionCardProps) {
  return (
    <Card title={title} className="marketing-analytics-section">
      {subtitle && (
        <div className="text-sm text-slate-500 mb-3">
          {subtitle}
        </div>
      )}
      {loading ? (
        <div className="py-4 px-0 text-slate-400 text-base">Loading…</div>
      ) : empty ? (
        <div className="py-4 px-0 text-slate-400 text-base">{empty}</div>
      ) : (
        children
      )}
    </Card>
  );
}

// Static Tailwind lookup — only 2/3/4 columns are ever used here, so the class
// strings are literal (no dynamic class construction, no inline style).
const GRID_COLS: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
};

interface StatGridProps { children?: ReactNode; cols?: number }

function StatGrid({ children, cols = 4 }: StatGridProps) {
  return (
    <div className={`grid gap-3 ${GRID_COLS[cols] ?? GRID_COLS[4]}`}>
      {children}
    </div>
  );
}

interface RfmRow { label: string; count: number }
interface AcquisitionRow { source: string; count: number }

interface CustomerData {
  total_customers?: number;
  new_customers_in_period?: number;
  rfm_distribution?: RfmRow[];
  acquisition_sources?: AcquisitionRow[];
}

interface CustomerGrowthResponse {
  ok?: boolean;
  data?: CustomerData;
  err?: unknown;
}

interface CustomerSectionProps { data?: CustomerData | undefined; loading: boolean }

function CustomerSection({ data, loading }: CustomerSectionProps) {
  const empty = !loading && (!data || data.total_customers === 0);
  return (
    <SectionCard
      title="Customer Insights"
      subtitle="Lifetime customer base, RFM mix, and acquisition sources."
      loading={loading}
      empty={empty ? 'No customer data yet.' : null}
    >
      {data && (
        <>
          <StatGrid cols={3}>
            <StatCard label="Total customers" value={fmtNum(data.total_customers)} />
            <StatCard label="New in period" value={fmtNum(data.new_customers_in_period)} />
            <StatCard
              label="RFM segments"
              value={fmtNum(data.rfm_distribution?.length || 0)}
            />
          </StatGrid>
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div>
              <div className="text-sm text-slate-500 mb-1.5">
                RFM distribution
              </div>
              <ul className="list-none p-0 m-0 text-sm">
                {(data.rfm_distribution || []).map((r) => (
                  <li
                    key={r.label}
                    className="flex justify-between py-1 px-0"
                  >
                    <span>{r.label}</span>
                    <strong>{fmtNum(r.count)}</strong>
                  </li>
                ))}
                {(data.rfm_distribution || []).length === 0 && (
                  <li className="text-slate-400">No data.</li>
                )}
              </ul>
            </div>
            <div>
              <div className="text-sm text-slate-500 mb-1.5">
                Acquisition sources
              </div>
              <ul className="list-none p-0 m-0 text-sm">
                {(data.acquisition_sources || []).slice(0, 8).map((r) => (
                  <li
                    key={r.source}
                    className="flex justify-between py-1 px-0"
                  >
                    <span>{r.source}</span>
                    <strong>{fmtNum(r.count)}</strong>
                  </li>
                ))}
                {(data.acquisition_sources || []).length === 0 && (
                  <li className="text-slate-400">No data.</li>
                )}
              </ul>
            </div>
          </div>
        </>
      )}
    </SectionCard>
  );
}

// Scoped wrapper: owns its own period chip selector + data fetch so the lifted
// Customer Insights block is self-contained on the customers page (which has no
// existing period/date control to reuse).
export default function CustomerInsightsSection() {
  const [period, setPeriod] = useState<string>('30d');
  const [loading, setLoading] = useState<boolean>(true);
  const [data, setData] = useState<CustomerData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCustomerGrowth(period)
      .then((resRaw) => {
        if (cancelled) return;
        const res = resRaw as CustomerGrowthResponse | null | undefined;
        if (!res || res.ok === false) {
          setData(null);
        } else {
          setData(res.data || null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [period]);

  return (
    <div>
      <div className="chips mb-4">
        {PERIODS.map(([val, label]) => (
          <button
            key={val}
            type="button"
            className={period === val ? 'chip on' : 'chip'}
            onClick={() => setPeriod(val)}
          >
            {label}
          </button>
        ))}
      </div>
      <CustomerSection data={data ?? undefined} loading={loading} />
    </div>
  );
}
