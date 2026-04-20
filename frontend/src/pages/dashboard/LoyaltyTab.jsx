import { useCallback, useEffect, useState } from 'react';
import StatCard from '../../components/StatCard.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import { useRestaurant } from '../../contexts/RestaurantContext.jsx';
import {
  getLoyaltyCustomers,
  getLoyaltyStats,
} from '../../api/restaurant.js';

// Mirrors loadLoyalty() in legacy js/tabs/restaurant.js:385.

const PAGE_LIMIT = 20;

const TIERS = [
  { key: 'platinum', label: '💎 Platinum', color: 'var(--acc)' },
  { key: 'gold',     label: '🥇 Gold',     color: 'var(--gold)' },
  { key: 'silver',   label: '🥈 Silver',   color: 'var(--blue)' },
  { key: 'bronze',   label: '🥉 Bronze',   color: 'var(--dim)' },
];

const TIER_META = {
  platinum: { emoji: '💎', color: 'var(--acc)' },
  gold:     { emoji: '🥇', color: 'var(--gold)' },
  silver:   { emoji: '🥈', color: 'var(--blue)' },
  bronze:   { emoji: '🥉', color: 'var(--dim)' },
};

function TierBadge({ tier }) {
  const t = tier || 'bronze';
  const meta = TIER_META[t] || TIER_META.bronze;
  return (
    <span style={{ color: meta.color, fontWeight: 600 }}>
      {meta.emoji} {t.charAt(0).toUpperCase() + t.slice(1)}
    </span>
  );
}

function waInfo(rest) {
  if (!rest) return { phone: null, connected: false, catalog: null, waba: '—' };
  const waPhone =
    rest.wa_phone_number ||
    rest.waba_accounts?.[0]?.phone ||
    rest.waba_accounts?.[0]?.wa_phone_number ||
    null;
  const connected = !!(
    waPhone ||
    rest.whatsapp_connected ||
    rest.meta_user_id ||
    rest.waba_accounts?.length
  );
  const catalog = rest.meta_catalog_id || rest.catalog_id || null;
  const waba = rest.meta_waba_id || rest.waba_accounts?.[0]?.waba_id || '—';
  return { phone: waPhone, connected, catalog, waba };
}

function customerIdentifier(c) {
  if (c.wa_phone) return c.wa_phone;
  if (c.bsuid) return `${String(c.bsuid).slice(0, 12)}…`;
  return '—';
}

export default function LoyaltyTab() {
  const { restaurant } = useRestaurant();
  const wa = waInfo(restaurant);

  const [page, setPage] = useState(1);

  const [stats, setStats] = useState(null);
  const [statsErr, setStatsErr] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const [list, setList] = useState(null);
  const [listErr, setListErr] = useState(null);
  const [listLoading, setListLoading] = useState(true);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsErr(null);
    try {
      const data = await getLoyaltyStats();
      setStats(data || null);
    } catch (err) {
      setStatsErr(err?.userMessage || err?.message || 'Could not load loyalty stats');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListErr(null);
    try {
      const data = await getLoyaltyCustomers({ page, limit: PAGE_LIMIT });
      setList(data || null);
    } catch (err) {
      setListErr(err?.userMessage || err?.message || 'Could not load members');
    } finally {
      setListLoading(false);
    }
  }, [page]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadList(); }, [loadList]);

  const totalMembers = stats?.total_members || 0;
  const issued = (stats?.total_points_issued || 0).toLocaleString();
  const redeemed = (stats?.total_points_redeemed || 0).toLocaleString();
  const tierCounts = stats?.tiers || {};

  return (
    <div id="tab-loyalty" className="tab on">
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch">
          <h3>WhatsApp Connection</h3>
        </div>
        <div
          className="stats"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}
        >
          <div className="stat">
            <div className="stat-l">Phone</div>
            <div className="stat-v" id="wa-info-phone" style={{ fontSize: '.95rem' }}>
              {wa.phone ? (
                <span style={{ color: 'var(--wa)' }}>{wa.phone} ✅</span>
              ) : wa.connected ? (
                <span style={{ color: 'var(--wa)' }}>Connected ✅</span>
              ) : (
                <span style={{ color: 'var(--red)' }}>Not Connected ❌</span>
              )}
            </div>
          </div>
          <div className="stat">
            <div className="stat-l">Catalog</div>
            <div className="stat-v" id="wa-info-catalog" style={{ fontSize: '.95rem' }}>
              {wa.catalog ? (
                <span style={{ color: 'var(--wa)' }}>{wa.catalog} ✅</span>
              ) : (
                <span style={{ color: 'var(--red)' }}>No catalog ❌</span>
              )}
            </div>
          </div>
          <div className="stat">
            <div className="stat-l">WABA ID</div>
            <div className="stat-v" id="wa-info-waba" style={{ fontSize: '.95rem' }}>
              {wa.waba}
            </div>
          </div>
        </div>
      </div>

      {statsErr ? (
        <div style={{ marginBottom: '1rem' }}>
          <SectionError message={statsErr} onRetry={loadStats} />
        </div>
      ) : (
        <div className="stats" style={{ marginBottom: '1rem' }}>
          <StatCard
            label="Total Members"
            value={statsLoading ? '—' : totalMembers}
            delta="Loyalty customers"
          />
          <StatCard
            label="Points Issued"
            value={statsLoading ? '—' : issued}
            delta="Lifetime"
          />
          <StatCard
            label="Points Redeemed"
            value={statsLoading ? '—' : redeemed}
            delta="Lifetime"
          />
          <div className="stat">
            <div className="stat-l">Tier Breakdown</div>
            <div id="ly-tiers" style={{ marginTop: '.3rem' }}>
              {statsLoading ? (
                <span style={{ color: 'var(--dim)', fontSize: '.8rem' }}>Loading…</span>
              ) : (
                TIERS.map((t) => (
                  <div
                    key={t.key}
                    style={{ display: 'flex', justifyContent: 'space-between', margin: '.15rem 0' }}
                  >
                    <span style={{ color: t.color }}>{t.label}</span>
                    <strong>{tierCounts[t.key] || 0}</strong>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="ch">
          <h3>Loyalty Members</h3>
          <span id="ly-count" style={{ color: 'var(--dim)', fontSize: '.8rem' }}>
            {list ? `${list.total} members` : ''}
          </span>
        </div>

        {listErr ? (
          <SectionError message={listErr} onRetry={loadList} />
        ) : (
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Contact</th>
                  <th style={{ textAlign: 'center' }}>Balance</th>
                  <th style={{ textAlign: 'center' }}>Lifetime</th>
                  <th style={{ textAlign: 'center' }}>Tier</th>
                  <th style={{ textAlign: 'center' }}>Orders</th>
                  <th style={{ textAlign: 'right' }}>Spent</th>
                </tr>
              </thead>
              <tbody id="ly-tbody">
                {listLoading ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--dim)' }}>
                      Loading…
                    </td>
                  </tr>
                ) : !list?.customers?.length ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--dim)' }}>
                      No loyalty members yet. Points are earned automatically after each delivered order.
                    </td>
                  </tr>
                ) : (
                  list.customers.map((c, i) => (
                    <tr key={c.id || c.bsuid || `${c.customer_name}-${i}`} style={{ borderBottom: '1px solid var(--rim)' }}>
                      <td>{c.customer_name}</td>
                      <td style={{ fontSize: '.75rem', color: 'var(--dim)' }}>
                        {customerIdentifier(c)}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 600 }}>{c.points_balance}</td>
                      <td style={{ textAlign: 'center', color: 'var(--dim)' }}>{c.lifetime_points}</td>
                      <td style={{ textAlign: 'center' }}><TierBadge tier={c.tier} /></td>
                      <td style={{ textAlign: 'center' }}>{c.total_orders}</td>
                      <td style={{ textAlign: 'right' }}>
                        ₹{parseFloat(c.total_spent_rs || 0).toFixed(0)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {list && list.pages > 1 && (
          <div
            id="ly-pager"
            style={{ display: 'flex', gap: '.3rem', flexWrap: 'wrap', marginTop: '.8rem' }}
          >
            {Array.from({ length: list.pages }, (_, i) => i + 1).map((p) => {
              const active = p === page;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPage(p)}
                  style={{
                    padding: '.3rem .6rem',
                    border: `1px solid ${active ? 'var(--acc)' : 'var(--rim)'}`,
                    borderRadius: 'var(--r)',
                    background: active ? 'var(--acc)' : '#fff',
                    color: active ? '#fff' : 'var(--tx)',
                    cursor: 'pointer',
                    fontSize: '.75rem',
                  }}
                >
                  {p}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
