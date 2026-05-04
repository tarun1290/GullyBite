// Branch detail: menu grouped by category with per-item stock toggles.
// The list comes from getOwnerBranchMenu(branchId), which mirrors the
// /api/staff/menu shape. Toggle is optimistic — flip local state first,
// call API in background, revert + show inline error on failure so the
// kitchen never sees a "stuck" switch.
//
// Header title is the branch name passed via route params from the
// branches list. If the user opens a deep-link directly (no name param)
// we fall back to the static "Branch" title from the Stack layout.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  SectionList,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';

import { getOwnerBranchMenu, toggleItemStock, type StaffMenuItem } from '@/api';
import { colors } from '@/theme';

type Section = { title: string; data: StaffMenuItem[] };

function formatRupees(n: number | undefined): string {
  if (typeof n !== 'number') return '';
  try { return n.toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
  catch { return String(Math.round(n)); }
}

export default function BranchDetailScreen() {
  const { branchId, name } = useLocalSearchParams<{ branchId: string; name?: string }>();
  const navigation = useNavigation();

  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Per-item revert error so a failed toggle surfaces locally instead of
  // wiping the screen-level err message after a successful refetch.
  const [itemErrs, setItemErrs] = useState<Record<string, string>>({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  // Push the branch name into the Stack header. Falls back to "Branch"
  // (the static title in branches/_layout.tsx) when no name was passed.
  useEffect(() => {
    if (name) navigation.setOptions({ title: name });
  }, [navigation, name]);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const res = await getOwnerBranchMenu(branchId);
      const cats = (res.categories || []).map((c) => ({ title: c.name, data: c.items || [] }));
      setSections(cats);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message || 'Failed to load menu');
    }
  }, [branchId]);

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

  // Optimistic: flip local item.is_available immediately, call API in
  // background. On error, restore the previous value and stash a per-item
  // error string so the row shows what went wrong.
  const onToggle = useCallback(async (item: StaffMenuItem, next: boolean) => {
    const prev = item.is_available;
    setPendingIds((s) => { const n = new Set(s); n.add(item.id); return n; });
    setItemErrs((m) => { const n = { ...m }; delete n[item.id]; return n; });
    setSections((cur) => cur.map((c) => ({
      ...c,
      data: c.data.map((it) => it.id === item.id ? { ...it, is_available: next } : it),
    })));
    try {
      await toggleItemStock(item.id, next);
    } catch (e) {
      setSections((cur) => cur.map((c) => ({
        ...c,
        data: c.data.map((it) => it.id === item.id ? { ...it, is_available: prev } : it),
      })));
      setItemErrs((m) => ({ ...m, [item.id]: (e as Error).message || 'Toggle failed' }));
    } finally {
      setPendingIds((s) => { const n = new Set(s); n.delete(item.id); return n; });
    }
  }, []);

  if (loading) {
    return (
      <View style={styles.flexCenter}>
        <ActivityIndicator color={colors.acc} />
      </View>
    );
  }

  if (err && sections.length === 0) {
    return (
      <View style={styles.flexCenter}>
        <Text style={styles.errMsg}>{err}</Text>
      </View>
    );
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} />}
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
        </View>
      )}
      renderItem={({ item }) => {
        const price = typeof item.price_rs === 'number'
          ? item.price_rs
          : (typeof item.price === 'number' ? item.price : undefined);
        const inFlight = pendingIds.has(item.id);
        const itemErr = itemErrs[item.id];
        return (
          <View style={styles.itemRow}>
            <View style={styles.itemTextWrap}>
              <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
              {price !== undefined ? <Text style={styles.itemPrice}>₹{formatRupees(price)}</Text> : null}
              {itemErr ? <Text style={styles.itemErr}>{itemErr}</Text> : null}
            </View>
            <Switch
              value={!!item.is_available}
              onValueChange={(v) => onToggle(item, v)}
              disabled={inFlight}
              trackColor={{ false: colors.rim2, true: colors.acc }}
              thumbColor={colors.ink2}
            />
          </View>
        );
      }}
      ListEmptyComponent={
        <View style={styles.flexCenter}>
          <Text style={styles.emptyText}>No menu items for this branch yet.</Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  listContent: { padding: 16, paddingBottom: 32, gap: 4 },
  flexCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: colors.ink },

  sectionHeader: { paddingTop: 12, paddingBottom: 6 },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: colors.dim, textTransform: 'uppercase', letterSpacing: 0.5 },

  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.ink2,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.rim,
    gap: 12,
    marginBottom: 6,
  },
  itemTextWrap: { flex: 1, gap: 2 },
  itemName: { fontSize: 14, fontWeight: '600', color: colors.tx },
  itemPrice: { fontSize: 12, color: colors.dim },
  itemErr: { fontSize: 11, color: colors.red, marginTop: 2 },

  errMsg: { color: colors.red, fontSize: 13, textAlign: 'center' },
  emptyText: { color: colors.dim, fontSize: 13, textAlign: 'center' },
});
