// Owner dashboard: greeting, today's totals, per-branch open/closed toggle.
// Single source of truth — getOwnerDashboard() drives every count, total,
// and badge on this screen. Pull-to-refresh re-runs the same fetch.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getOwnerDashboard, toggleBranchOpen } from '@/api';
import { useAuth } from '@/store/authStore';
import { colors } from '@/theme';

type BranchRow = {
  id: string;
  name: string;
  is_open: boolean;
  accepts_orders: boolean;
  subscription_status: string;
  today_orders: number;
  today_revenue_rs: number;
};

type DashboardResp = {
  restaurant: { id: string; name: string; slug: string };
  branches: BranchRow[];
  totals: {
    today_orders: number;
    today_revenue_rs: number;
    active_branches: number;
    paused_branches: number;
  };
};

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatRupees(n: number): string {
  // Indian grouping (1,23,456) — locale-aware via Intl-like formatter
  // available in the JS engine. Fall back to fixed-2 if it throws.
  try {
    return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  } catch {
    return String(Math.round(n));
  }
}

export default function OwnerDashboardScreen() {
  const { ownerInfo, restaurant } = useAuth();
  const [data, setData] = useState<DashboardResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Per-branch in-flight set so the Switch is disabled during the toggle
  // round-trip without re-rendering every other row.
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = (await getOwnerDashboard()) as DashboardResp;
      setData(res);
      setErr(null);
    } catch (e) {
      const msg = (e as Error).message || 'Failed to load dashboard';
      setErr(msg);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await load();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const onToggle = useCallback(async (branchId: string, next: boolean) => {
    setTogglingIds((s) => {
      const n = new Set(s); n.add(branchId); return n;
    });
    try {
      await toggleBranchOpen(branchId, next);
      await load();
    } catch (e) {
      // Surface failure as the inline err line — the dashboard re-fetch
      // didn't run, so the Switch will snap back to its server state on
      // the next refresh.
      setErr((e as Error).message || 'Toggle failed');
    } finally {
      setTogglingIds((s) => {
        const n = new Set(s); n.delete(branchId); return n;
      });
    }
  }, [load]);

  if (loading) {
    return (
      <SafeAreaView edges={['bottom']} style={styles.flexCenter}>
        <ActivityIndicator color={colors.acc} />
      </SafeAreaView>
    );
  }

  if (err && !data) {
    return (
      <SafeAreaView edges={['bottom']} style={styles.flexCenter}>
        <Text style={styles.errMsg}>{err}</Text>
        <Pressable onPress={() => { setLoading(true); load().finally(() => setLoading(false)); }} style={styles.retryBtn}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const totals = data?.totals;
  const branches = data?.branches || [];
  const greeting = greetingFor(new Date().getHours());
  const ownerName = ownerInfo?.name || '';
  const restaurantName = restaurant?.name || data?.restaurant?.name || '';

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} />}
    >
      <View style={{ gap: 4 }}>
        <Text style={styles.greeting}>{greeting}{ownerName ? `, ${ownerName}` : ''}</Text>
        {restaurantName ? <Text style={styles.subtitle}>{restaurantName}</Text> : null}
      </View>

      {totals ? (
        <View style={styles.totalsCard}>
          <View style={styles.totalsRow}>
            <Tile label="Today's Orders" value={String(totals.today_orders)} />
            <Tile label="Today's Revenue" value={`₹${formatRupees(totals.today_revenue_rs)}`} />
          </View>
          <View style={styles.totalsRow}>
            <Tile label="Active Branches" value={String(totals.active_branches)} />
            <Tile
              label="Paused Branches"
              value={String(totals.paused_branches)}
              valueColor={totals.paused_branches > 0 ? colors.red : undefined}
            />
          </View>
        </View>
      ) : null}

      {err && data ? <Text style={styles.errMsg}>{err}</Text> : null}

      {branches.map((b) => {
        const subBadge = subscriptionBadgeColors(b.subscription_status);
        const inFlight = togglingIds.has(b.id);
        return (
          <View key={b.id} style={styles.branchCard}>
            <View style={styles.branchHeader}>
              <Text style={styles.branchName} numberOfLines={1}>{b.name}</Text>
              <View style={[styles.subBadge, { backgroundColor: subBadge.bg }]}>
                <Text style={[styles.subBadgeText, { color: subBadge.fg }]}>
                  {b.subscription_status || '—'}
                </Text>
              </View>
            </View>

            <View style={styles.toggleRow}>
              <Text style={styles.openLabel}>
                {b.is_open ? '🟢 Open' : '🔴 Closed'}
              </Text>
              <Switch
                value={b.is_open}
                onValueChange={(v) => onToggle(b.id, v)}
                disabled={inFlight}
                trackColor={{ false: colors.rim2, true: colors.acc }}
                thumbColor={colors.ink2}
              />
            </View>

            <Text style={styles.branchStat}>
              Today: {b.today_orders} orders · ₹{formatRupees(b.today_revenue_rs)}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

function Tile({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

function subscriptionBadgeColors(status: string | null | undefined): { bg: string; fg: string } {
  if (status === 'active') return { bg: '#dcfce7', fg: '#15803d' };
  if (status === 'paused' || status === 'force_paused') return { bg: '#fee2e2', fg: '#b91c1c' };
  return { bg: '#f3f4f6', fg: '#4b5563' };
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 12, paddingBottom: 32 },
  flexCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16, backgroundColor: colors.ink },

  greeting: { fontSize: 20, fontWeight: '800', color: colors.tx },
  subtitle: { fontSize: 13, color: colors.dim },

  totalsCard: {
    backgroundColor: colors.ink2,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.rim,
    gap: 12,
  },
  totalsRow: { flexDirection: 'row', gap: 12 },
  tile: { flex: 1, backgroundColor: colors.ink, borderRadius: 10, padding: 12, gap: 4, borderWidth: 1, borderColor: colors.rim },
  tileLabel: { fontSize: 11, color: colors.dim, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: '700' },
  tileValue: { fontSize: 22, fontWeight: '800', color: colors.tx },

  branchCard: {
    backgroundColor: colors.ink2,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.rim,
    gap: 10,
  },
  branchHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  branchName: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.tx },
  subBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  subBadgeText: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  openLabel: { fontSize: 14, color: colors.tx, fontWeight: '600' },
  branchStat: { fontSize: 12, color: colors.dim },

  errMsg: { color: colors.red, fontSize: 13, textAlign: 'center' },
  retryBtn: { backgroundColor: colors.acc, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  retryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
