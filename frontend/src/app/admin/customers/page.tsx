'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  getAdminCustomerIdentity,
  getAdminCustomers,
} from '../../../api/admin';

const CUST_LIMIT = 50;

interface AdminCustomerRow {
  _id?: string;
  wa_phone?: string;
  bsuid?: string;
  name?: string;
  order_count?: number;
  lifetime_rs?: number | string;
  created_at?: string;
}

interface RestaurantBreakdown {
  restaurant_id?: string;
  order_count?: number;
  total_spent_rs?: number | string;
}

interface IdentityRow {
  name?: string;
  phone?: string;
  total_orders?: number;
  total_spent_rs?: number | string;
  customer_type?: string;
  tags?: string[];
  restaurant_breakdown?: RestaurantBreakdown[];
}

interface IdentityResponse {
  items?: IdentityRow[];
}

const TYPE_COLOR: Record<string, string> = {
  new: 'var(--dim)',
  repeat: 'var(--gb-wa-500)',
  loyal: '#f5a623',
  dormant: 'var(--gb-red-500)',
};

function fmtNum(n: number | string | null | undefined): string {
  const v = Number(n || 0);
  try { return v.toLocaleString('en-IN'); } catch { return String(v); }
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
  } catch { return '—'; }
}

const TH_CLS = 'py-[0.6rem] px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-[0.6rem] px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const SEL_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.3rem] px-[0.55rem] text-[0.78rem]';

export default function AdminCustomersPage() {
  const [search, setSearch] = useState<string>('');
  const [offset, setOffset] = useState<number>(0);
  const [showBsuid, setShowBsuid] = useState<boolean>(false);

  const [rows, setRows] = useState<AdminCustomerRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingSearch, setPendingSearch] = useState<string>('');

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearch(pendingSearch);
      setOffset(0);
    }, 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [pendingSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const params: Record<string, string | number> = { limit: CUST_LIMIT, offset };
    if (search.trim()) params.search = search.trim();
    try {
      const data = (await getAdminCustomers(params)) as AdminCustomerRow[] | null;
      setRows(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, [search, offset]);

  useEffect(() => { load(); }, [load]);

  const page = Math.floor(offset / CUST_LIMIT) + 1;
  const canNext = rows.length === CUST_LIMIT;

  const [gRestaurant, setGRestaurant] = useState<string>('');
  const [gType, setGType] = useState<string>('');
  const [gMinOrders, setGMinOrders] = useState<string>('');
  const [gSort, setGSort] = useState<string>('orders');
  const [gRows, setGRows] = useState<IdentityRow[]>([]);
  const [gLoading, setGLoading] = useState<boolean>(true);
  const [gErr, setGErr] = useState<string | null>(null);
  const [gExpanded, setGExpanded] = useState<Set<number>>(() => new Set());

  const loadGlobal = useCallback(async () => {
    setGLoading(true);
    setGErr(null);
    const params: Record<string, string | number> = { limit: 100 };
    if (gRestaurant.trim()) params.restaurant_id = gRestaurant.trim();
    if (gType) params.customer_type = gType;
    if (gMinOrders) params.min_orders = gMinOrders;
    if (gSort) params.sort = gSort;
    try {
      const d = (await getAdminCustomerIdentity(params)) as IdentityResponse | null;
      setGRows(Array.isArray(d?.items) ? d.items : []);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setGErr(er?.response?.data?.error || er?.message || 'Failed to load identity metrics');
    } finally {
      setGLoading(false);
    }
  }, [gRestaurant, gType, gMinOrders, gSort]);

  useEffect(() => { loadGlobal(); }, [loadGlobal]);

  const toggleExpand = (i: number) => {
    const next = new Set(gExpanded);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setGExpanded(next);
  };

  const colSpan = useMemo<number>(() => (showBsuid ? 6 : 5), [showBsuid]);

  return (
    <div id="pg-customers">
      <div className="card mb-4">
        <div className="ch gap-[0.6rem] flex-wrap">
          <h3>Customers</h3>
          <label className="ml-auto inline-flex items-center gap-[0.3rem] text-dim text-[0.72rem]">
            <input type="checkbox" checked={showBsuid} onChange={(e) => setShowBsuid(e.target.checked)} />
            Show WhatsApp Username (BSUID)
          </label>
          <input
            type="text"
            placeholder="Search phone / name…"
            value={pendingSearch}
            onChange={(e) => setPendingSearch(e.target.value)}
            className={`${SEL_CLS} w-[200px]`}
          />
        </div>
        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={TH_CLS}>Phone</th>
                  <th className={TH_CLS}>Name</th>
                  {showBsuid && <th className={TH_CLS}>WhatsApp Username (BSUID)</th>}
                  <th className={TH_CLS}>Orders</th>
                  <th className={TH_CLS}>Lifetime Value</th>
                  <th className={TH_CLS}>Joined</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={colSpan} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={colSpan} className={EMPTY_CLS}>No customers found</td></tr>
                ) : (
                  rows.map((c, i) => (
                    <tr key={c._id || c.wa_phone || c.bsuid || i} className="border-b border-rim">
                      <td className={`${TD_CLS} mono`}>
                        {c.wa_phone || (c.bsuid ? `${String(c.bsuid).slice(0, 12)}…` : '—')}
                      </td>
                      <td className={TD_CLS}>{c.name || '—'}</td>
                      {showBsuid && (
                        <td className={`${TD_CLS} text-[0.72rem] text-dim mono`} title={c.bsuid || ''}>
                          {c.bsuid ? `${String(c.bsuid).slice(0, 8)}…` : '—'}
                        </td>
                      )}
                      <td className={`${TD_CLS} text-center`}>{c.order_count}</td>
                      <td className={TD_CLS}>₹{fmtNum(c.lifetime_rs)}</td>
                      <td className={`${TD_CLS} text-dim text-[0.74rem]`}>{fmtDate(c.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="py-[0.7rem] px-4 flex gap-[0.6rem] items-center border-t border-rim">
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => setOffset(Math.max(0, offset - CUST_LIMIT))}
            disabled={loading || offset === 0}
          >← Prev</button>
          <span className="text-[0.78rem] text-dim">Page {page}</span>
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => setOffset(offset + CUST_LIMIT)}
            disabled={loading || !canNext}
          >Next →</button>
        </div>
      </div>

      <div className="card">
        <div className="ch gap-[0.6rem] flex-wrap">
          <h3>Global Identity</h3>
          <span className="text-dim text-[0.72rem]">Cross-restaurant totals</span>
          <div className="ml-auto flex gap-2 flex-wrap">
            <input
              placeholder="Restaurant ID"
              value={gRestaurant}
              onChange={(e) => setGRestaurant(e.target.value)}
              className={`${SEL_CLS} w-52`}
            />
            <select value={gType} onChange={(e) => setGType(e.target.value)} className={SEL_CLS}>
              <option value="">All Types</option>
              <option value="new">New</option>
              <option value="repeat">Repeat</option>
              <option value="loyal">Loyal</option>
              <option value="dormant">Dormant</option>
            </select>
            <input
              type="number"
              min={0}
              placeholder="Min Orders"
              value={gMinOrders}
              onChange={(e) => setGMinOrders(e.target.value)}
              className={`${SEL_CLS} w-28`}
            />
            <select value={gSort} onChange={(e) => setGSort(e.target.value)} className={SEL_CLS}>
              <option value="orders">Sort: Total Orders</option>
              <option value="spent">Sort: Total Spend</option>
              <option value="last_order">Sort: Last Order</option>
            </select>
            <button type="button" className="btn-g btn-sm" onClick={loadGlobal} disabled={gLoading}>↻</button>
          </div>
        </div>
        {gErr ? (
          <div className="cb"><SectionError message={gErr} onRetry={loadGlobal} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={TH_CLS} />
                  <th className={TH_CLS}>Name</th>
                  <th className={TH_CLS}>Phone</th>
                  <th className={TH_CLS}>Total Orders</th>
                  <th className={TH_CLS}>Total Spend</th>
                  <th className={TH_CLS}>Type</th>
                </tr>
              </thead>
              <tbody>
                {gLoading ? (
                  <tr><td colSpan={6} className={EMPTY_CLS}>Loading…</td></tr>
                ) : gRows.length === 0 ? (
                  <tr><td colSpan={6} className={EMPTY_CLS}>No customers match</td></tr>
                ) : (
                  gRows.map((c, i) => {
                    const color = TYPE_COLOR[c.customer_type || ''] || 'var(--dim)';
                    const highValue = (c.tags || []).indexOf('high_value') >= 0;
                    const expanded = gExpanded.has(i);
                    return (
                      <Fragment key={c.phone || c.name || i}>
                        <tr className="border-b border-rim">
                          <td className={TD_CLS}>
                            <button
                              type="button"
                              className="btn-g btn-sm py-[0.1rem] px-[0.4rem]"
                              onClick={() => toggleExpand(i)}
                            >{expanded ? '▾' : '▸'}</button>
                          </td>
                          <td className={TD_CLS}>{c.name || '—'}</td>
                          <td className={`${TD_CLS} mono`}>{c.phone || '—'}</td>
                          <td className={`${TD_CLS} text-center`}>{c.total_orders || 0}</td>
                          <td className={TD_CLS}>₹{fmtNum(c.total_spent_rs)}</td>
                          <td
                            className={`${TD_CLS} uppercase font-bold text-[0.72rem]`}
                            // colour comes from TYPE_COLOR by customer_type
                            // at runtime (new/repeat/loyal/dormant — 4 distinct).
                            style={{ color }}
                          >
                            {c.customer_type || '—'}
                            {highValue && (
                              <span className="ml-[0.35rem] text-[0.6rem] py-[0.05rem] px-[0.3rem] rounded-[3px] bg-[#f5a62322] text-[#f5a623]">
                                HIGH VALUE
                              </span>
                            )}
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td></td>
                            <td colSpan={5} className="bg-ink3 py-[0.6rem] px-[0.8rem]">
                              {(c.restaurant_breakdown || []).length === 0 ? (
                                <div className="text-dim text-[0.72rem]">No restaurant breakdown</div>
                              ) : (
                                (c.restaurant_breakdown || []).map((b, j) => (
                                  <div key={j} className="mono text-[0.72rem]">
                                    <span className="text-dim">{String(b.restaurant_id)}</span>
                                    {' — '}
                                    {b.order_count} orders, ₹{fmtNum(b.total_spent_rs)}
                                  </div>
                                ))
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
