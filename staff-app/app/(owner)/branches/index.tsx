// Branches list: same data source as the dashboard (getOwnerDashboard)
// — fetched here too so a tab switch doesn't show a stale snapshot if the
// dashboard hasn't been opened yet. Tap a card to drill into menu /
// stock toggles for that branch.

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
import { useRouter } from 'expo-router';

import { getOwnerDashboard, toggleBranchOpen } from '@/api';
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

function formatRupees(n: number): string {
  try { return n.toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
  catch { return String(Math.round(n)); }
}

export default function BranchesListScreen() {
  const router = useRouter();
  const { isManager } = useRole();
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = (await getOwnerDashboard()) as DashboardResp;
      setBranches(res.branches || []);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message || 'Failed to load branches');
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
    setTogglingIds((s) => { const n = new Set(s); n.add(branchId); return n; });
    try {
      await toggleBranchOpen(branchId, next);
      await load();
    } catch (e) {
      setErr((e as Error).message || 'Toggle failed');
    } finally {
      setTogglingIds((s) => { const n = new Set(s); n.delete(branchId); return n; });
    }
  }, [load]);

  if (loading) {
    return (
      <View style={styles.flexCenter}>
        <ActivityIndicator color={colors.acc} />
      </View>
    );
  }

  if (err && branches.length === 0) {
    return (
      <View style={styles.flexCenter}>
        <Text style={styles.errMsg}>{err}</Text>
        <Pressable onPress={() => { setLoading(true); load().finally(() => setLoading(false)); }} style={styles.retryBtn}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} />}
    >
      {err ? <Text style={styles.errMsg}>{err}</Text> : null}
      {branches.map((b) => {
        const subBadge = subscriptionBadgeFor(b.subscription_status);
        const inFlight = togglingIds.has(b.id);
        return (
          <Pressable
            key={b.id}
            onPress={() => router.push({ pathname: '/(owner)/branches/[branchId]', params: { branchId: b.id, name: b.name } })}
            style={({ pressed }) => [styles.branchCard, pressed && { opacity: 0.85 }]}
          >
            <View style={styles.branchHeader}>
              <Text style={styles.branchName} numberOfLines={1}>{b.name}</Text>
              <View style={[styles.subBadge, { backgroundColor: subBadge.bg }]}>
                <Text style={[styles.subBadgeText, { color: subBadge.fg }]}>
                  {b.subscription_status || '—'}
                </Text>
              </View>
            </View>
            <View style={styles.toggleRow}>
              <Text style={styles.openLabel}>{b.is_open ? '🟢 Open' : '🔴 Closed'}</Text>
              {/* Branch open/close toggle — manager-only. Status text
                  on the left stays visible so the row still reads as
                  open/closed for everyone; only the Switch control is
                  gated. */}
              {isManager && (
                /* Stop the Switch from triggering the row's Pressable.
                   RN's Switch swallows its own touches, but wrapping
                   in a View with onStartShouldSetResponder removes any
                   accidental bubbling on Android. */
                <View onStartShouldSetResponder={() => true}>
                  <Switch
                    value={b.is_open}
                    onValueChange={(v) => onToggle(b.id, v)}
                    disabled={inFlight}
                    trackColor={{ false: colors.rim2, true: colors.acc }}
                    thumbColor={colors.ink2}
                  />
                </View>
              )}
            </View>
            <Text style={styles.branchStat}>
              Today: {b.today_orders} orders · ₹{formatRupees(b.today_revenue_rs)}
            </Text>
            <Text style={styles.tapHint}>Tap to manage menu →</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.px4, gap: space.px3, paddingBottom: space.px8 },
  flexCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.px3, padding: space.px4, backgroundColor: colors.ink },

  branchCard: {
    backgroundColor: colors.ink2,
    borderRadius: radius['2xl'], // was 14, rounded to 16 (2xl)
    padding: space.px4,
    borderWidth: 1,
    borderColor: colors.rim,
    gap: space.px2,
  },
  branchHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.px2 },
  branchName: { flex: 1, fontSize: text.md, fontWeight: fontWeight.bold, color: colors.tx },
  subBadge: { paddingHorizontal: space.px2, paddingVertical: space.px1, borderRadius: radius.sm }, // was paddingVertical 3, rounded to 4 (px1)
  subBadgeText: { fontSize: text.xs, fontWeight: fontWeight.bold, textTransform: 'uppercase', letterSpacing: 0.3 }, // was 11, rounded to 11.5 (xs)

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  openLabel: { fontSize: text.base, color: colors.tx, fontWeight: fontWeight.semibold },
  branchStat: { fontSize: text.xs, color: colors.dim }, // was 12, rounded to 11.5 (xs)
  tapHint: { fontSize: text.xs, color: colors.acc, fontWeight: fontWeight.semibold }, // was 11, rounded to 11.5 (xs)

  errMsg: { color: colors.red, fontSize: text.sm, textAlign: 'center' },
  retryBtn: { backgroundColor: colors.acc, paddingHorizontal: space.px5, paddingVertical: space.px3, borderRadius: radius.lg }, // was paddingHorizontal 18, rounded to 20 (px5); paddingVertical 10, rounded to 12 (px3)
  retryText: { color: '#fff', fontSize: text.base, fontWeight: fontWeight.bold },
});
