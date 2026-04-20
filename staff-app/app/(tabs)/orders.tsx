import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OrderCard } from '@/components/OrderCard';
import { StaffOrder, getOrders, updateOrderStatus } from '@/api';
import { StaffSse, SseState } from '@/sse';
import { playNewOrderChime, unloadChime } from '@/sound';
import { playLocalNewOrderNotification } from '@/push';
import { colors } from '@/theme';

export default function OrdersScreen() {
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [sseState, setSseState] = useState<SseState>('connecting');
  const [refreshing, setRefreshing] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string | null>>({});
  const highlightMap = useRef<Map<string, Animated.Value>>(new Map());
  const sseRef = useRef<StaffSse | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getOrders();
      setOrders(Array.isArray(res?.orders) ? res.orders : []);
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as Error).message || 'Failed to load orders');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // SSE with reconnect + re-fetch on every (re)connect.
  useEffect(() => {
    let prevState: SseState = 'connecting';
    const sse = new StaffSse({
      onNewOrder: (payload) => {
        const newOrder: StaffOrder = {
          id: String(payload.id || payload.order_id || ''),
          order_number: payload.order_number || null,
          customer_name: payload.customer_name,
          customer_phone_masked: payload.customer_phone_masked,
          total_rs: payload.total_rs,
          status: payload.status || 'PENDING_PAYMENT',
          payment_status: payload.payment_status,
          created_at: payload.created_at,
          items: Array.isArray(payload.items) ? payload.items : [],
        };
        if (!newOrder.id) return;

        // Highlight animation value scoped to this order id.
        const anim = new Animated.Value(1);
        highlightMap.current.set(newOrder.id, anim);
        Animated.timing(anim, { toValue: 0, duration: 1600, useNativeDriver: false }).start();

        setOrders((prev) => {
          if (prev.some((o) => o.id === newOrder.id)) return prev;
          return [newOrder, ...prev];
        });

        // Best-effort sound + local notification.
        void playNewOrderChime();
        void playLocalNewOrderNotification(
          'New Order!',
          `#${newOrder.order_number || ''} — ${
            newOrder.total_rs != null ? `₹${newOrder.total_rs}` : 'Incoming order'
          }`
        );
      },
      onOrderUpdated: (payload) => {
        const id = String(payload.id || payload.order_id || '');
        if (!id) return;
        setOrders((prev) =>
          prev.map((o) => (o.id === id ? { ...o, status: payload.status || o.status } : o))
        );
      },
      onState: (state) => {
        setSseState(state);
        if (state === 'live' && prevState !== 'live') {
          // On every fresh connect, re-sync to catch any missed events.
          void load();
        }
        prevState = state;
      },
    });
    sseRef.current = sse;
    void sse.connect();
    return () => {
      sse.close();
      sseRef.current = null;
      void unloadChime();
    };
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  const handleStatus = async (orderId: string, toStatus: string) => {
    setBusy((b) => ({ ...b, [orderId]: toStatus }));
    // Optimistic: update card badge immediately, rollback on failure.
    const prevStatus = orders.find((o) => o.id === orderId)?.status;
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, status: statusDbFor(toStatus) } : o))
    );
    try {
      await updateOrderStatus(orderId, toStatus);
    } catch (e) {
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, status: prevStatus } : o))
      );
      setLoadErr((e as Error).message || 'Status update failed');
    } finally {
      setBusy((b) => ({ ...b, [orderId]: null }));
    }
  };

  const pillStyle =
    sseState === 'live'
      ? styles.pillLive
      : sseState === 'reconnecting'
      ? styles.pillAmber
      : styles.pillDim;
  const dotColor =
    sseState === 'live' ? colors.wa : sseState === 'reconnecting' ? colors.gold : colors.mute;
  const pillLabel =
    sseState === 'live' ? 'Live' : sseState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }} edges={['left', 'right', 'bottom']}>
      <View style={styles.statusBar}>
        <View style={[styles.pill, pillStyle]}>
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
          <Text style={styles.pillText}>{pillLabel}</Text>
        </View>
        {loadErr && (
          <Pressable onPress={() => setLoadErr(null)} style={styles.errChip}>
            <Text style={styles.errText}>{loadErr}</Text>
          </Pressable>
        )}
      </View>
      <FlatList
        data={orders}
        keyExtractor={(o) => o.id}
        renderItem={({ item }) => (
          <OrderCard
            order={item}
            busyStatus={busy[item.id] || null}
            onStatusChange={handleStatus}
            highlight={highlightMap.current.get(item.id)}
          />
        )}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No active orders</Text>
            <Text style={styles.emptySub}>New orders will appear here instantly.</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

// The API payload uses lowercase status names but the server emits uppercase
// in order docs. Map optimistic toStatus into the DB enum the OrderCard expects.
function statusDbFor(to: string): string {
  switch (to) {
    case 'confirmed': return 'CONFIRMED';
    case 'preparing': return 'PREPARING';
    case 'ready': return 'PACKED';
    case 'out_for_delivery': return 'DISPATCHED';
    case 'delivered': return 'DELIVERED';
    case 'cancelled': return 'CANCELLED';
    default: return to;
  }
}

const styles = StyleSheet.create({
  statusBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: colors.rim,
    backgroundColor: colors.ink2,
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99,
  },
  pillLive: { backgroundColor: '#dcfce7' },
  pillAmber: { backgroundColor: '#fef3c7' },
  pillDim: { backgroundColor: '#f3f4f6' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '700', color: colors.tx },
  errChip: {
    backgroundColor: '#fee2e2', paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 8, flex: 1,
  },
  errText: { color: colors.red, fontSize: 12, fontWeight: '600' },
  list: { padding: 12, paddingBottom: 40 },
  empty: { alignItems: 'center', padding: 40, gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.tx },
  emptySub: { fontSize: 13, color: colors.dim, textAlign: 'center' },
});
