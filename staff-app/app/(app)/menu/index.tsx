import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { StaffMenuItem, getMenu, updateItemAvailability } from '@/api';
import { useStaff } from '@/state/StaffContext';
import { colors, primitives, space, text, radius, fontWeight } from '@/theme';
import { formatRs } from '@/time';

type Section =
  | { kind: 'header'; key: string; title: string }
  | { kind: 'item'; key: string; item: StaffMenuItem };

export default function MenuScreen() {
  // Branch selection drives getMenu's X-Branch-Id header (set globally
  // by authStore). Adding it to load's deps re-runs the fetch when the
  // operator picks a different branch from the header selector.
  const { currentBranchId } = useStaff();
  const [categories, setCategories] = useState<Array<{ name: string; items: StaffMenuItem[] }>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getMenu();
      setCategories(Array.isArray(res?.categories) ? res.categories : []);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message || 'Failed to load menu');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBranchId]);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  const rows: Section[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Section[] = [];
    for (const cat of categories) {
      const items = q
        ? cat.items.filter((i) => (i.name || '').toLowerCase().includes(q))
        : cat.items;
      if (!items.length) continue;
      out.push({ kind: 'header', key: `h:${cat.name}`, title: cat.name });
      for (const it of items) {
        out.push({ kind: 'item', key: `i:${it.id}`, item: it });
      }
    }
    return out;
  }, [categories, query]);

  const showToast = (text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind });
    setTimeout(() => setToast(null), 1800);
  };

  const toggle = async (item: StaffMenuItem, next: boolean) => {
    if (busy[item.id]) return;
    // Optimistic update — mutate state first, revert on failure.
    setCategories((cats) =>
      cats.map((c) => ({
        ...c,
        items: c.items.map((it) => (it.id === item.id ? { ...it, is_available: next } : it)),
      }))
    );
    setBusy((b) => ({ ...b, [item.id]: true }));
    try {
      await updateItemAvailability(item.id, next);
      showToast(`${item.name} is now ${next ? 'available' : 'paused'}`, 'ok');
    } catch (e) {
      setCategories((cats) =>
        cats.map((c) => ({
          ...c,
          items: c.items.map((it) => (it.id === item.id ? { ...it, is_available: !next } : it)),
        }))
      );
      showToast((e as Error).message || 'Update failed', 'err');
    } finally {
      setBusy((b) => ({ ...b, [item.id]: false }));
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }} edges={['left', 'right', 'bottom']}>
      <View style={styles.searchBar}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search items…"
          placeholderTextColor={colors.mute}
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.acc} />
        </View>
      ) : err ? (
        <View style={styles.center}>
          <Text style={styles.errText}>{err}</Text>
          <Pressable style={styles.retry} onPress={load}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={({ item }) =>
            item.kind === 'header' ? (
              <Text style={styles.header}>{item.title}</Text>
            ) : (
              <MenuRow
                item={item.item}
                busy={!!busy[item.item.id]}
                onToggle={(v) => toggle(item.item, v)}
              />
            )
          }
          contentContainerStyle={{ padding: space.px3, paddingBottom: space.px10 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>
                {query ? 'No items match your search' : 'No menu items yet'}
              </Text>
            </View>
          }
        />
      )}

      {toast && (
        <Animated.View
          style={[
            styles.toast,
            toast.kind === 'ok' ? styles.toastOk : styles.toastErr,
          ]}
          pointerEvents="none"
        >
          <Text
            style={[
              styles.toastText,
              toast.kind === 'ok' ? { color: colors.wa } : { color: colors.red },
            ]}
          >
            {toast.text}
          </Text>
        </Animated.View>
      )}
    </SafeAreaView>
  );
}

function MenuRow({
  item, busy, onToggle,
}: { item: StaffMenuItem; busy: boolean; onToggle: (v: boolean) => void }) {
  const price = item.price_rs ?? item.price ?? null;
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.itemName}>{item.name}</Text>
        <Text style={styles.itemPrice}>{formatRs(price)}</Text>
      </View>
      <Switch
        value={!!item.is_available}
        onValueChange={onToggle}
        disabled={busy}
        trackColor={{ false: colors.rim2, true: colors.acc }}
        thumbColor={'#fff'}
        style={{ transform: [{ scaleX: 1.15 }, { scaleY: 1.15 }] }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  searchBar: { padding: space.px3, paddingBottom: space.px1, backgroundColor: colors.ink },
  search: {
    backgroundColor: colors.ink2, borderWidth: 1, borderColor: colors.rim,
    borderRadius: radius.xl, paddingHorizontal: space.px4, paddingVertical: space.px3, // was 14, rounded to 16 (px4)
    fontSize: text.lg, color: colors.tx, // was 16, rounded to 17 (lg)
  },

  header: {
    fontSize: text.sm, fontWeight: fontWeight.extrabold, letterSpacing: 1.2,
    color: colors.dim, textTransform: 'uppercase',
    marginTop: space.px4, marginBottom: space.px1, paddingHorizontal: space.px1, // was 14, rounded to 16 (px4)
  },
  row: {
    backgroundColor: colors.ink2,
    borderWidth: 1, borderColor: colors.rim, borderRadius: radius.xl,
    padding: space.px4, marginBottom: space.px2, // was 14, rounded to 16 (px4)
    flexDirection: 'row', alignItems: 'center', gap: space.px3,
  },
  itemName: { fontSize: text.lg, fontWeight: fontWeight.bold, color: colors.tx }, // was 16, rounded to 17 (lg)
  itemPrice: { fontSize: text.base, color: colors.dim, marginTop: space.px1 }, // was 2, rounded to 4 (px1)

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.px6, gap: space.px3 },
  errText: { color: colors.red, fontSize: text.base, textAlign: 'center' },
  retry: {
    backgroundColor: colors.acc, paddingHorizontal: space.px4, paddingVertical: space.px3, borderRadius: radius.lg, // was 18, rounded to 16 (px4); was 10, rounded to 12 (px3)
  },
  retryText: { color: '#fff', fontWeight: fontWeight.bold },
  emptyTitle: { color: colors.dim, fontSize: text.base },

  toast: {
    position: 'absolute', left: 20, right: 20, bottom: 24,
    borderRadius: radius.lg, paddingHorizontal: space.px4, paddingVertical: space.px3, // was 14, rounded to 16 (px4); was 10, rounded to 12 (px3)
    borderWidth: 1,
  },
  // toastOk uses Tailwind green-50 (#f0fdf4) and green-200 (#bbf7d0) which
  // are NOT primitives in @gullybite/design-tokens (only the Fresh Leaf
  // green ramp is — primitives.green.50 = '#E6F5EC' / .200 = '#C7E8D5').
  // Left as inline literals; flagged for a Part 2 amendment to add
  // Tailwind-green primitives.
  toastOk: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  toastErr: { backgroundColor: primitives.rose['50'], borderColor: primitives.red['200'] },
  toastText: { fontSize: text.sm, fontWeight: fontWeight.semibold },
});
