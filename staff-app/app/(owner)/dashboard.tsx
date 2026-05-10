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
import { useStaff } from '@/state/StaffContext';
import { useRole } from '@/hooks/useRole';
import { colors, fontWeight, radius, space, subscriptionBadgeFor, text } from '@/theme';

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
  const { ownerInfo, restaurant } = useStaff();
  const { isManager } = useRole();
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
      <View style={{ gap: space.px1 }}>
        <Text style={styles.greeting}>{greeting}{ownerName ? `, ${ownerName}` : ''}</Text>
        {restaurantName ? <Text style={styles.subtitle}>{restaurantName}</Text> : null}
      </View>

      {/* Daily sales summary — manager-only. Hidden for plain staff
          even if they ever reach this screen (defense-in-depth on top
          of the route guard, which sends staff to /(app)/orders). */}
      {isManager && totals ? (
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
        const subBadge = subscriptionBadgeFor(b.subscription_status);
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
              {/* Branch open/close toggle — manager-only. Status text
                  on the left stays visible for everyone so the row
                  still communicates the branch state; only the Switch
                  control is gated. */}
              {isManager && (
                <Switch
                  value={b.is_open}
                  onValueChange={(v) => onToggle(b.id, v)}
                  disabled={inFlight}
                  trackColor={{ false: colors.rim2, true: colors.acc }}
                  thumbColor={colors.ink2}
                />
              )}
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

const styles = StyleSheet.create({
  scroll: { padding: space.px4, gap: space.px3, paddingBottom: space.px8 },
  flexCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.px3, padding: space.px4, backgroundColor: colors.ink },

  greeting: { fontSize: text.xl, fontWeight: fontWeight.extrabold, color: colors.tx },
  subtitle: { fontSize: text.sm, color: colors.dim },

  totalsCard: {
    backgroundColor: colors.ink2,
    borderRadius: radius['2xl'], // was 14, rounded to 16 (2xl)
    padding: space.px4,
    borderWidth: 1,
    borderColor: colors.rim,
    gap: space.px3,
  },
  totalsRow: { flexDirection: 'row', gap: space.px3 },
  tile: { flex: 1, backgroundColor: colors.ink, borderRadius: radius.lg, padding: space.px3, gap: space.px1, borderWidth: 1, borderColor: colors.rim },
  tileLabel: { fontSize: text.xs, color: colors.dim, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: fontWeight.bold }, // was 11, rounded to 11.5 (xs)
  tileValue: { fontSize: text.xl, fontWeight: fontWeight.extrabold, color: colors.tx }, // was 22, rounded to 20 (xl)

  branchCard: {
    backgroundColor: colors.ink2,
    borderRadius: radius['2xl'], // was 14, rounded to 16 (2xl)
    padding: space.px4,
    borderWidth: 1,
    borderColor: colors.rim,
    gap: space.px3, // was 10, rounded to 12 (px3)
  },
  branchHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.px2 },
  branchName: { flex: 1, fontSize: text.md, fontWeight: fontWeight.bold, color: colors.tx },
  subBadge: { paddingHorizontal: space.px2, paddingVertical: space.px1, borderRadius: radius.sm }, // was paddingVertical 3, rounded to 4 (px1)
  subBadgeText: { fontSize: text.xs, fontWeight: fontWeight.bold, textTransform: 'uppercase', letterSpacing: 0.3 }, // was 11, rounded to 11.5 (xs)

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  openLabel: { fontSize: text.base, color: colors.tx, fontWeight: fontWeight.semibold },
  branchStat: { fontSize: text.xs, color: colors.dim }, // was 12, rounded to 11.5 (xs)

  errMsg: { color: colors.red, fontSize: text.sm, textAlign: 'center' },
  retryBtn: { backgroundColor: colors.acc, paddingHorizontal: space.px5, paddingVertical: space.px3, borderRadius: radius.lg }, // was paddingHorizontal 18, rounded to 20 (px5); paddingVertical 10, rounded to 12 (px3)
  retryText: { color: '#fff', fontSize: text.base, fontWeight: fontWeight.bold },
});
