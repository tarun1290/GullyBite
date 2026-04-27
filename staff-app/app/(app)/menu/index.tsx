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
import { colors } from '@/theme';
import { formatRs } from '@/time';

type Section =
  | { kind: 'header'; key: string; title: string }
  | { kind: 'item'; key: string; item: StaffMenuItem };

export default function MenuScreen() {
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
  }, []);

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
          contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
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
  searchBar: { padding: 12, paddingBottom: 4, backgroundColor: colors.ink },
  search: {
    backgroundColor: colors.ink2, borderWidth: 1, borderColor: colors.rim,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 16, color: colors.tx,
  },

  header: {
    fontSize: 13, fontWeight: '800', letterSpacing: 1.2,
    color: colors.dim, textTransform: 'uppercase',
    marginTop: 14, marginBottom: 4, paddingHorizontal: 4,
  },
  row: {
    backgroundColor: colors.ink2,
    borderWidth: 1, borderColor: colors.rim, borderRadius: 12,
    padding: 14, marginBottom: 8,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  itemName: { fontSize: 16, fontWeight: '700', color: colors.tx },
  itemPrice: { fontSize: 14, color: colors.dim, marginTop: 2 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  errText: { color: colors.red, fontSize: 14, textAlign: 'center' },
  retry: {
    backgroundColor: colors.acc, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10,
  },
  retryText: { color: '#fff', fontWeight: '700' },
  emptyTitle: { color: colors.dim, fontSize: 14 },

  toast: {
    position: 'absolute', left: 20, right: 20, bottom: 24,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1,
  },
  toastOk: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  toastErr: { backgroundColor: '#fff1f2', borderColor: '#fecaca' },
  toastText: { fontSize: 13, fontWeight: '600' },
});
