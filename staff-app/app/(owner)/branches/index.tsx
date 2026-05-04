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

function formatRupees(n: number): string {
  try { return n.toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
  catch { return String(Math.round(n)); }
}

function subscriptionBadgeColors(status: string | null | undefined): { bg: string; fg: string } {
  if (status === 'active') return { bg: '#dcfce7', fg: '#15803d' };
  if (status === 'paused' || status === 'force_paused') return { bg: '#fee2e2', fg: '#b91c1c' };
  return { bg: '#f3f4f6', fg: '#4b5563' };
}

export default function BranchesListScreen() {
  const router = useRouter();
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
        const subBadge = subscriptionBadgeColors(b.subscription_status);
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
              {/* Stop the Switch from triggering the row's Pressable. RN's
                  Switch swallows its own touches, but wrapping in a View
                  with onStartShouldSetResponder removes any accidental
                  bubbling on Android. */}
              <View onStartShouldSetResponder={() => true}>
                <Switch
                  value={b.is_open}
                  onValueChange={(v) => onToggle(b.id, v)}
                  disabled={inFlight}
                  trackColor={{ false: colors.rim2, true: colors.acc }}
                  thumbColor={colors.ink2}
                />
              </View>
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
  scroll: { padding: 16, gap: 12, paddingBottom: 32 },
  flexCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16, backgroundColor: colors.ink },

  branchCard: {
    backgroundColor: colors.ink2,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.rim,
    gap: 8,
  },
  branchHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  branchName: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.tx },
  subBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  subBadgeText: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  openLabel: { fontSize: 14, color: colors.tx, fontWeight: '600' },
  branchStat: { fontSize: 12, color: colors.dim },
  tapHint: { fontSize: 11, color: colors.acc, fontWeight: '600' },

  errMsg: { color: colors.red, fontSize: 13, textAlign: 'center' },
  retryBtn: { backgroundColor: colors.acc, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  retryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
