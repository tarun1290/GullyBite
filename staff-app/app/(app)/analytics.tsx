// Manager-only branch analytics — today (IST calendar day).
//
// Scope decision 2026-05-14: managers (and owners by extension via
// useRole.isManager) get a basic "what happened today" surface for
// their assigned branch(es). Plain staff do not see this tab and
// can't deep-link to it — the screen body defense bounces them to
// <NoAccessScreen/>.
//
// Data source:
//   GET /api/restaurant/analytics/overview?period=1d&branch_id=X
//     → today's order count, revenue, customers, % change vs yesterday
//   GET /api/restaurant/analytics/top-items?period=1d&limit=5&branch_id=X
//     → top 5 items by quantity sold today
//
// '1d' is the IST-calendar-day preset added to _analyticsContext()
// in backend/src/routes/restaurant.js for this screen — UTC midnight
// cuts the IST day at 5:30 AM and would split the morning rush
// across two buckets.
//
// Branch switcher: only renders when the manager has 2+ branches
// assigned. Single-branch managers see the bare screen.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  AnalyticsOverviewResponse,
  AnalyticsTopItem,
  getAnalyticsToday,
  getAnalyticsTopItemsToday,
} from '@/api';
import { useStaff } from '@/state/StaffContext';
import { useRole } from '@/hooks/useRole';
import NoAccessScreen from '@/components/NoAccessScreen';
import { colors, space, text, radius, fontWeight } from '@/theme';
import { formatRs } from '@/time';

export default function AnalyticsScreenGate(): React.ReactElement {
  const { isManager } = useRole();
  if (!isManager) {
    return (
      <NoAccessScreen message="Analytics is available to managers only. Ask your owner to upgrade your role if you need access." />
    );
  }
  return <AnalyticsScreen />;
}

function AnalyticsScreen() {
  const { staffUser, currentBranchId, setCurrentBranchId } = useStaff();
  const branches = staffUser?.branches || [];
  const branchIds = staffUser?.branchIds || (staffUser?.branchId ? [staffUser.branchId] : []);
  const multiBranch = branchIds.length > 1;

  // Effective branch the analytics call is scoped to:
  //   • Multi-branch + specific selection → use that id.
  //   • Multi-branch + 'all' → omit branch_id (aggregate across all).
  //   • Single-branch session → use the primary branchId.
  const effectiveBranchId = useMemo<string | null>(() => {
    if (multiBranch && currentBranchId && currentBranchId !== 'all') return currentBranchId;
    if (multiBranch && currentBranchId === 'all') return null; // backend aggregates when omitted
    return staffUser?.branchId || null;
  }, [multiBranch, currentBranchId, staffUser?.branchId]);

  const [overview, setOverview] = useState<AnalyticsOverviewResponse | null>(null);
  const [topItems, setTopItems] = useState<AnalyticsTopItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ov, items] = await Promise.all([
        getAnalyticsToday(effectiveBranchId),
        getAnalyticsTopItemsToday(effectiveBranchId, 5),
      ]);
      setOverview(ov);
      setTopItems(Array.isArray(items) ? items : []);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e?.message || 'Failed to load analytics');
    }
  }, [effectiveBranchId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
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

  const selectedBranchName = useMemo<string>(() => {
    if (!effectiveBranchId) return 'All branches';
    return branches.find((b) => b.id === effectiveBranchId)?.name || 'Branch';
  }, [branches, effectiveBranchId]);

  if (loading) {
    return (
      <SafeAreaView edges={['bottom']} style={styles.safe}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.acc} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} />}
      >
        {/* Branch switcher chips — only when 2+ branches assigned.
            Single-branch managers see no chrome change. */}
        {multiBranch && (
          <View style={styles.branchRow}>
            <Pressable
              onPress={() => setCurrentBranchId('all')}
              style={[styles.chip, (!currentBranchId || currentBranchId === 'all') && styles.chipOn]}
            >
              <Text style={[styles.chipText, (!currentBranchId || currentBranchId === 'all') && styles.chipTextOn]}>
                All
              </Text>
            </Pressable>
            {branches.map((b) => (
              <Pressable
                key={b.id}
                onPress={() => setCurrentBranchId(b.id)}
                style={[styles.chip, currentBranchId === b.id && styles.chipOn]}
              >
                <Text style={[styles.chipText, currentBranchId === b.id && styles.chipTextOn]}>
                  {b.name}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        <Text style={styles.headline}>Today · {selectedBranchName}</Text>
        <Text style={styles.subhead}>IST calendar day</Text>

        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={() => { void load(); }} style={styles.retryBtn}>
              <Text style={styles.retryBtnText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {overview && (
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Orders</Text>
              <Text style={styles.statValue}>{overview.total_orders}</Text>
              <Text style={[styles.statDelta, deltaStyle(overview.changes.orders_pct)]}>
                {formatDelta(overview.changes.orders_pct)} vs yesterday
              </Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Revenue</Text>
              <Text style={styles.statValue}>{formatRs(overview.total_revenue_rs)}</Text>
              <Text style={[styles.statDelta, deltaStyle(overview.changes.revenue_pct)]}>
                {formatDelta(overview.changes.revenue_pct)} vs yesterday
              </Text>
            </View>
          </View>
        )}

        {overview && (
          <View style={styles.smallStatsRow}>
            <View style={styles.smallStat}>
              <Text style={styles.smallStatLabel}>Avg order</Text>
              <Text style={styles.smallStatValue}>{formatRs(overview.avg_order_value_rs)}</Text>
            </View>
            <View style={styles.smallStat}>
              <Text style={styles.smallStatLabel}>Customers</Text>
              <Text style={styles.smallStatValue}>{overview.total_customers}</Text>
            </View>
          </View>
        )}

        <Text style={styles.sectionTitle}>Top items today</Text>
        {topItems.length === 0 ? (
          <Text style={styles.empty}>No items sold yet today.</Text>
        ) : (
          <View style={styles.topList}>
            {topItems.map((it, i) => (
              <View key={`${it.item_name}-${i}`} style={styles.topRow}>
                <Text style={styles.topRank}>{i + 1}</Text>
                <View style={styles.topNameWrap}>
                  <Text style={styles.topName} numberOfLines={1}>{it.item_name}</Text>
                  <Text style={styles.topMeta}>
                    {it.total_quantity} sold · {it.order_count} orders
                  </Text>
                </View>
                <Text style={styles.topRevenue}>{formatRs(it.total_revenue_rs)}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function formatDelta(pct: number): string {
  if (pct === 0) return '±0%';
  const sign = pct > 0 ? '▲' : '▼';
  return `${sign} ${Math.abs(pct)}%`;
}

function deltaStyle(pct: number): { color: string } {
  if (pct > 0) return { color: colors.wa };
  if (pct < 0) return { color: colors.red };
  return { color: colors.dim };
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.ink },
  scroll: { padding: space.px4, gap: space.px4 },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  branchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.px2 },
  chip: {
    paddingHorizontal: space.px3,
    paddingVertical: space.px2,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.rim,
    backgroundColor: colors.ink2,
  },
  chipOn: { backgroundColor: colors.acc, borderColor: colors.acc },
  chipText: { color: colors.dim, fontSize: text.sm, fontWeight: fontWeight.semibold },
  chipTextOn: { color: colors.ink },
  headline: { color: colors.tx, fontSize: text.lg, fontWeight: fontWeight.bold },
  subhead: { color: colors.dim, fontSize: text.xs, marginTop: -space.px3 },
  statsRow: { flexDirection: 'row', gap: space.px3 },
  statCard: {
    flex: 1,
    padding: space.px4,
    borderRadius: radius.lg,
    backgroundColor: colors.ink2,
    borderWidth: 1,
    borderColor: colors.rim,
  },
  statLabel: { color: colors.dim, fontSize: text.xs, fontWeight: fontWeight.semibold, textTransform: 'uppercase' },
  statValue: { color: colors.tx, fontSize: text.xl, fontWeight: fontWeight.bold, marginTop: space.px1 },
  statDelta: { fontSize: text.xs, marginTop: space.px1 },
  smallStatsRow: { flexDirection: 'row', gap: space.px3 },
  smallStat: { flex: 1, padding: space.px3, borderRadius: radius.md, backgroundColor: colors.ink2, borderWidth: 1, borderColor: colors.rim },
  smallStatLabel: { color: colors.dim, fontSize: text.xs, fontWeight: fontWeight.semibold },
  smallStatValue: { color: colors.tx, fontSize: text.md, fontWeight: fontWeight.bold, marginTop: space.px1 },
  sectionTitle: { color: colors.tx, fontSize: text.md, fontWeight: fontWeight.bold, marginTop: space.px2 },
  empty: { color: colors.dim, fontSize: text.sm, fontStyle: 'italic' },
  topList: { gap: space.px2 },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.px3,
    padding: space.px3,
    borderRadius: radius.md,
    backgroundColor: colors.ink2,
    borderWidth: 1,
    borderColor: colors.rim,
  },
  topRank: { color: colors.dim, fontSize: text.md, fontWeight: fontWeight.bold, width: 24 },
  topNameWrap: { flex: 1 },
  topName: { color: colors.tx, fontSize: text.sm, fontWeight: fontWeight.semibold },
  topMeta: { color: colors.dim, fontSize: text.xs, marginTop: 2 },
  topRevenue: { color: colors.tx, fontSize: text.sm, fontWeight: fontWeight.semibold },
  errorCard: { padding: space.px3, borderRadius: radius.md, backgroundColor: colors.ink2, borderWidth: 1, borderColor: colors.rim },
  errorText: { color: colors.red, fontSize: text.sm },
  retryBtn: { marginTop: space.px2, alignSelf: 'flex-start', paddingHorizontal: space.px3, paddingVertical: space.px2, borderRadius: radius.md, backgroundColor: colors.acc },
  retryBtnText: { color: colors.ink, fontSize: text.sm, fontWeight: fontWeight.semibold },
});
