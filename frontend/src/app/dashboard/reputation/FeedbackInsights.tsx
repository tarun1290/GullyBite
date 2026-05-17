'use client';

// Lifted verbatim from the (being-deleted) marketing-analytics page:
// the Feedback & Reviews section + its data shapes and the SectionCard /
// StatGrid / fmtNum / fmtPct helpers it depends on. Card/StatCard imports
// keep the same relative path that worked from marketing-analytics/page.tsx
// (both pages sit at the same depth under src/app/dashboard/<page>/).
import { useEffect, useState, type ReactNode } from 'react';
import Card from '../../../components/Card';
import StatCard from '../../../components/StatCard';
import { getFeedbackInsights } from '../../../api/restaurant';

const PERIODS: ReadonlyArray<readonly [string, string]> = [
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];

function fmtPct(ratio: number | string | null | undefined): string {
  if (ratio == null || Number.isNaN(Number(ratio))) return '—';
  return (Number(ratio) * 100).toFixed(1) + '%';
}

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

// Tailwind rule: dynamic gridTemplateColumns is forbidden in this scope, so
// the lifted inline `style={{ gridTemplateColumns }}` is replaced with a
// static literal lookup. Only 2/3/4 columns are ever requested here.
const COL_CLASS: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
};

interface StatGridProps { children?: ReactNode; cols?: number }

function StatGrid({ children, cols = 4 }: StatGridProps) {
  const colsClass = COL_CLASS[cols] ?? COL_CLASS[4];
  return (
    <div className={`grid gap-3 ${colsClass}`}>
      {children}
    </div>
  );
}

interface RatingDistRow { rating: number | string; count: number }
interface BySourceRow { source: string; count: number; avg_rating?: number | null }

interface FeedbackData {
  total?: number;
  avg_rating?: number | null;
  positive_share?: number;
  review_link_ctr?: number;
  rating_distribution?: RatingDistRow[];
  by_source?: BySourceRow[];
}

interface FeedbackInsightsResponse {
  ok?: boolean;
  data?: FeedbackData;
  err?: unknown;
}

interface FeedbackSectionProps { data?: FeedbackData | undefined; loading: boolean }

function FeedbackSection({ data, loading }: FeedbackSectionProps) {
  const empty = !loading && (!data || data.total === 0);
  return (
    <SectionCard
      title="Feedback & Reviews"
      subtitle="Ratings, positive share, Google-review link click-through."
      loading={loading}
      empty={empty ? 'No feedback collected yet in this period.' : null}
    >
      {data && (data.total ?? 0) > 0 && (
        <>
          <StatGrid cols={4}>
            <StatCard label="Responses" value={fmtNum(data.total)} />
            <StatCard label="Avg. rating" value={data.avg_rating != null ? data.avg_rating + ' / 5' : '—'} />
            <StatCard label="Positive" value={fmtPct(data.positive_share)} />
            <StatCard label="Review-link CTR" value={fmtPct(data.review_link_ctr)} />
          </StatGrid>
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div>
              <div className="text-sm text-slate-500 mb-1.5">
                Rating distribution
              </div>
              <ul className="list-none p-0 m-0 text-sm">
                {(data.rating_distribution || []).map((r) => (
                  <li
                    key={r.rating}
                    className="flex justify-between py-1 px-0"
                  >
                    <span>{'★'.repeat(Number(r.rating))}</span>
                    <strong>{fmtNum(r.count)}</strong>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-sm text-slate-500 mb-1.5">
                By source
              </div>
              <ul className="list-none p-0 m-0 text-sm">
                {(data.by_source || []).map((r) => (
                  <li
                    key={r.source}
                    className="flex justify-between py-1 px-0"
                  >
                    <span>
                      {r.source}
                      {r.avg_rating != null && (
                        <span className="text-slate-400 ml-1">
                          ({r.avg_rating}★)
                        </span>
                      )}
                    </span>
                    <strong>{fmtNum(r.count)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </SectionCard>
  );
}

// Self-contained header strip for the Review Links area: owns its own
// period selector (scoped — the page's other window control belongs to the
// untouched Rating Overview) and fetches the lifted feedback section.
export default function FeedbackInsights() {
  const [period, setPeriod] = useState<string>('30d');
  const [loading, setLoading] = useState<boolean>(true);
  const [data, setData] = useState<FeedbackData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getFeedbackInsights(period)
      .then((resRaw) => {
        if (cancelled) return;
        const res = resRaw as FeedbackInsightsResponse | null | undefined;
        if (!res || res.ok === false) {
          setError("Couldn't load feedback — check your connection and refresh.");
          setData(null);
        } else {
          setData(res.data || null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Couldn't load feedback — check your connection and refresh.");
        setData(null);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [period]);

  return (
    <div className="mb-4">
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

      {error ? (
        <div className="bg-red-100 border border-red-200 rounded-lg py-3 px-4 text-base text-red-800 mb-4">
          {error}
        </div>
      ) : (
        <FeedbackSection data={data ?? undefined} loading={loading} />
      )}
    </div>
  );
}
