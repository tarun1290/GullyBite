import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import {
  getAdminCustomerIdentity,
  getAdminCustomers,
} from '../../api/admin.js';

// Mirrors admin.html loadCustomers (2865-2961): two tables.
// 1. /api/admin/customers — per-restaurant customers with search/pagination
// 2. /api/admin/customers/identity — cross-restaurant identity aggregate

const CUST_LIMIT = 50;

function fmtNum(n) {
  const v = Number(n || 0);
  try { return v.toLocaleString('en-IN'); } catch { return String(v); }
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
  } catch { return '—'; }
}

const TYPE_COLOR = {
  new: 'var(--dim)',
  repeat: '#16a34a',
  loyal: '#f5a623',
  dormant: '#dc2626',
};

export default function AdminCustomers() {
  // ── Per-restaurant customers ─────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [showBsuid, setShowBsuid] = useState(false);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const searchTimer = useRef(null);
  const [pendingSearch, setPendingSearch] = useState('');

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
    const params = { limit: CUST_LIMIT, offset };
    if (search.trim()) params.search = search.trim();
    try {
      const data = await getAdminCustomers(params);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, [search, offset]);

  useEffect(() => { load(); }, [load]);

  const page = Math.floor(offset / CUST_LIMIT) + 1;
  const canNext = rows.length === CUST_LIMIT;

  // ── Global identity ──────────────────────────────────────────────────
  const [gRestaurant, setGRestaurant] = useState('');
  const [gType, setGType] = useState('');
  const [gMinOrders, setGMinOrders] = useState('');
  const [gSort, setGSort] = useState('orders');
  const [gRows, setGRows] = useState([]);
  const [gLoading, setGLoading] = useState(true);
  const [gErr, setGErr] = useState(null);
  const [gExpanded, setGExpanded] = useState(() => new Set());

  const loadGlobal = useCallback(async () => {
    setGLoading(true);
    setGErr(null);
    const params = { limit: 100 };
    if (gRestaurant.trim()) params.restaurant_id = gRestaurant.trim();
    if (gType) params.customer_type = gType;
    if (gMinOrders) params.min_orders = gMinOrders;
    if (gSort) params.sort = gSort;
    try {
      const d = await getAdminCustomerIdentity(params);
      setGRows(Array.isArray(d?.items) ? d.items : []);
    } catch (e) {
      setGErr(e?.response?.data?.error || e?.message || 'Failed to load identity metrics');
    } finally {
      setGLoading(false);
    }
  }, [gRestaurant, gType, gMinOrders, gSort]);

  useEffect(() => { loadGlobal(); }, [loadGlobal]);

  const toggleExpand = (i) => {
    const next = new Set(gExpanded);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setGExpanded(next);
  };

  const colSpan = useMemo(() => (showBsuid ? 6 : 5), [showBsuid]);

  return (
    <div id="pg-customers">
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch" style={{ gap: '.6rem', flexWrap: 'wrap' }}>
          <h3>Customers</h3>
          <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '.3rem', color: 'var(--dim)', fontSize: '.72rem' }}>
            <input type="checkbox" checked={showBsuid} onChange={(e) => setShowBsuid(e.target.checked)} />
            Show WhatsApp Username (BSUID)
          </label>
          <input
            type="text"
            placeholder="Search phone / name…"
            value={pendingSearch}
            onChange={(e) => setPendingSearch(e.target.value)}
            style={{ ...sel, width: 200 }}
          />
        </div>
        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', borderBottom: '1px solid var(--rim)' }}>
                  <th style={th}>Phone</th>
                  <th style={th}>Name</th>
                  {showBsuid && <th style={th}>WhatsApp Username (BSUID)</th>}
                  <th style={th}>Orders</th>
                  <th style={th}>Lifetime Value</th>
                  <th style={th}>Joined</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={colSpan} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={colSpan} style={emptyCell}>No customers found</td></tr>
                ) : (
                  rows.map((c, i) => (
                    <tr key={c._id || c.wa_phone || c.bsuid || i} style={{ borderBottom: '1px solid var(--rim)' }}>
                      <td style={td} className="mono">
                        {c.wa_phone || (c.bsuid ? `${String(c.bsuid).slice(0, 12)}…` : '—')}
                      </td>
                      <td style={td}>{c.name || '—'}</td>
                      {showBsuid && (
                        <td style={{ ...td, fontSize: '.72rem', color: 'var(--dim)' }} className="mono" title={c.bsuid || ''}>
                          {c.bsuid ? `${String(c.bsuid).slice(0, 8)}…` : '—'}
                        </td>
                      )}
                      <td style={{ ...td, textAlign: 'center' }}>{c.order_count}</td>
                      <td style={td}>₹{fmtNum(c.lifetime_rs)}</td>
                      <td style={{ ...td, color: 'var(--dim)', fontSize: '.74rem' }}>{fmtDate(c.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ padding: '.7rem 1rem', display: 'flex', gap: '.6rem', alignItems: 'center', borderTop: '1px solid var(--rim)' }}>
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => setOffset(Math.max(0, offset - CUST_LIMIT))}
            disabled={loading || offset === 0}
          >← Prev</button>
          <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Page {page}</span>
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => setOffset(offset + CUST_LIMIT)}
            disabled={loading || !canNext}
          >Next →</button>
        </div>
      </div>

      <div className="card">
        <div className="ch" style={{ gap: '.6rem', flexWrap: 'wrap' }}>
          <h3>Global Identity</h3>
          <span style={{ color: 'var(--dim)', fontSize: '.72rem' }}>Cross-restaurant totals</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
            <input
              placeholder="Restaurant ID"
              value={gRestaurant}
              onChange={(e) => setGRestaurant(e.target.value)}
              style={{ ...sel, width: '13rem' }}
            />
            <select value={gType} onChange={(e) => setGType(e.target.value)} style={sel}>
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
              style={{ ...sel, width: '7rem' }}
            />
            <select value={gSort} onChange={(e) => setGSort(e.target.value)} style={sel}>
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
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', borderBottom: '1px solid var(--rim)' }}>
                  <th style={th} />
                  <th style={th}>Name</th>
                  <th style={th}>Phone</th>
                  <th style={th}>Total Orders</th>
                  <th style={th}>Total Spend</th>
                  <th style={th}>Type</th>
                </tr>
              </thead>
              <tbody>
                {gLoading ? (
                  <tr><td colSpan={6} style={emptyCell}>Loading…</td></tr>
                ) : gRows.length === 0 ? (
                  <tr><td colSpan={6} style={emptyCell}>No customers match</td></tr>
                ) : (
                  gRows.map((c, i) => {
                    const color = TYPE_COLOR[c.customer_type] || 'var(--dim)';
                    const highValue = (c.tags || []).indexOf('high_value') >= 0;
                    const expanded = gExpanded.has(i);
                    return (
                      <Fragment key={c.phone || c.name || i}>
                        <tr style={{ borderBottom: '1px solid var(--rim)' }}>
                          <td style={td}>
                            <button
                              type="button"
                              className="btn-g btn-sm"
                              style={{ padding: '.1rem .4rem' }}
                              onClick={() => toggleExpand(i)}
                            >{expanded ? '▾' : '▸'}</button>
                          </td>
                          <td style={td}>{c.name || '—'}</td>
                          <td style={td} className="mono">{c.phone || '—'}</td>
                          <td style={{ ...td, textAlign: 'center' }}>{c.total_orders || 0}</td>
                          <td style={td}>₹{fmtNum(c.total_spent_rs)}</td>
                          <td style={{ ...td, textTransform: 'uppercase', fontWeight: 700, color, fontSize: '.72rem' }}>
                            {c.customer_type || '—'}
                            {highValue && (
                              <span style={{ marginLeft: '.35rem', fontSize: '.6rem', padding: '.05rem .3rem', borderRadius: 3, background: '#f5a62322', color: '#f5a623' }}>
                                HIGH VALUE
                              </span>
                            )}
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td></td>
                            <td colSpan={5} style={{ background: 'var(--ink3)', padding: '.6rem .8rem' }}>
                              {(c.restaurant_breakdown || []).length === 0 ? (
                                <div style={{ color: 'var(--dim)', fontSize: '.72rem' }}>No restaurant breakdown</div>
                              ) : (
                                c.restaurant_breakdown.map((b, j) => (
                                  <div key={j} className="mono" style={{ fontSize: '.72rem' }}>
                                    <span style={{ color: 'var(--dim)' }}>{String(b.restaurant_id)}</span>
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

const th = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td = { padding: '.6rem .7rem', verticalAlign: 'top' };
const emptyCell = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const sel = { background: '#fff', border: '1px solid var(--rim)', borderRadius: 6, padding: '.3rem .55rem', fontSize: '.78rem' };
