import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  Vibration,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { OrderCard } from '@/components/OrderCard';
import { StaffOrder, getOrders, updateOrderStatus, acceptOrder, declineOrder } from '@/api';
import { useAuth } from '@/store/authStore';
import { StaffSse, SseState } from '@/sse';
import { playNewOrderChime, unloadChime } from '@/sound';
import {
  getNotificationPermissionStatus,
  playLocalNewOrderNotification,
} from '@/push';
import { colors, primitives } from '@/theme';

// IST calendar-day helpers. The staff app fetches past orders by
// YYYY-MM-DD (IST) — these convert today/yesterday/etc. to the same
// boundary the backend expects without pulling in a date library.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDateString(d: Date): string {
  // Shift wallclock to IST then read year/month/day fields off the
  // shifted time-since-epoch via toISOString — slicing 0..10 gives
  // YYYY-MM-DD without timezone conversion drift.
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}
function istDaysAgo(n: number): string {
  return istDateString(new Date(Date.now() - n * 24 * 60 * 60 * 1000));
}
function formatPickerLabel(dateStr: string): string {
  const today = istDaysAgo(0);
  if (dateStr === today) return 'Today';
  if (dateStr === istDaysAgo(1)) return 'Yesterday';
  // YYYY-MM-DD → "DD MMM" for compact pill display.
  const [, m, d] = dateStr.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(d)} ${months[Number(m) - 1] || ''}`;
}

export default function OrdersScreen() {
  // currentBranchId is read from the auth store and threaded into the
  // load callback's deps so changing the branch in the header selector
  // re-runs getOrders with the updated X-Branch-Id header. The header
  // itself is set globally via api.setBranchHeader (driven by the same
  // authStore effect) — we don't need to pass branch into getOrders.
  const { currentBranchId } = useAuth();
  const router = useRouter();
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [sseState, setSseState] = useState<SseState>('connecting');
  const [refreshing, setRefreshing] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string | null>>({});
  const highlightMap = useRef<Map<string, Animated.Value>>(new Map());
  const sseRef = useRef<StaffSse | null>(null);
  // Date filter — null = "Live" (today's open orders, SSE-fed). A
  // YYYY-MM-DD string puts the screen in past-orders mode: SSE chime/
  // animations are suppressed and the orders list is the snapshot for
  // that day.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const isLive = selectedDate === null;
  const today = useMemo(() => istDaysAgo(0), []);
  // Permission state for the in-app "Enable notifications" banner.
  // Re-read on focus so flipping the OS toggle in Settings clears the
  // banner without requiring a sign-out cycle. 'denied' means the user
  // (or a previous install) explicitly turned notifications off and
  // the system won't re-prompt — only Settings can flip it.
  const [notifPerm, setNotifPerm] = useState<'granted' | 'denied' | 'undetermined'>('undetermined');
  useEffect(() => {
    let mounted = true;
    const check = async () => {
      const s = await getNotificationPermissionStatus();
      if (mounted) setNotifPerm(s);
    };
    void check();
    // Foreground re-check — when the user comes back from the OS
    // settings screen the AppState would change but we don't need a
    // listener; a re-render driven by RefreshControl or any state
    // change runs this effect through its dep on selectedDate. Cheap
    // enough that re-running on every screen re-render is fine.
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  const load = useCallback(async () => {
    try {
      const res = await getOrders(selectedDate ? { date: selectedDate } : undefined);
      setOrders(Array.isArray(res?.orders) ? res.orders : []);
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as Error).message || 'Failed to load orders');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBranchId, selectedDate]);

  useEffect(() => {
    void load();
  }, [load]);

  // SSE handlers need the current isLive flag without re-creating the
  // connection on every date toggle. Stash it in a ref the handlers
  // read inside their closures.
  const isLiveRef = useRef(isLive);
  useEffect(() => { isLiveRef.current = isLive; }, [isLive]);

  // SSE with reconnect + re-fetch on every (re)connect. Past-date
  // viewing leaves the connection up but suppresses chime/animation/
  // list-mutation — the snapshot of the past day shouldn't shift.
  useEffect(() => {
    let prevState: SseState = 'connecting';
    const sse = new StaffSse({
      onNewOrder: (payload) => {
        if (!isLiveRef.current) return;
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

        // Best-effort sound + vibration + local notification.
        // Vibration: explicit pattern (300ms on, 200ms off, 300ms on)
        // — fires once on arrival as a haptic reinforcement of the
        // chime. The Android `orders` channel also has a vibration
        // pattern attached, but that only fires when the system
        // banner posts; the explicit call covers the case where
        // notifications are denied / suppressed but the app is open.
        try { Vibration.vibrate([0, 300, 200, 300]); } catch { /* noop */ }
        void playNewOrderChime();
        // Body format matches the backend push: "Order #N • ₹T".
        const shortId = newOrder.order_number || newOrder.id.slice(0, 6);
        const totalLabel = newOrder.total_rs != null ? `₹${newOrder.total_rs}` : '';
        void playLocalNewOrderNotification(
          'New Order!',
          totalLabel ? `Order #${shortId} • ${totalLabel}` : `Order #${shortId}`,
          { order_id: newOrder.id }
        );
      },
      onOrderUpdated: (payload) => {
        if (!isLiveRef.current) return;
        const id = String(payload.id || payload.order_id || '');
        if (!id) return;
        setOrders((prev) =>
          prev.map((o) => (o.id === id ? { ...o, status: payload.status || o.status } : o))
        );
      },
      onState: (state) => {
        setSseState(state);
        if (state === 'live' && prevState !== 'live' && isLiveRef.current) {
          // On every fresh connect, re-sync the live list. Past-date
          // mode owns its own snapshot — don't blow it away on
          // reconnect.
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
    // load is intentionally not a dep — the SSE connection is long-
    // lived and the load fn is invoked through the ref-gated handlers.
    // Re-instantiating on every load identity change would churn the
    // connection on each date toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // PAID-specific actions go through different endpoints
  // (/api/restaurant/orders/:id/accept and /decline) — backed by the
  // requireStaffOrRestaurantAuth middleware on the backend. Stop the
  // alarm on either action so it doesn't keep ringing once handled.
  const handleAccept = async (orderId: string) => {
    setBusy((b) => ({ ...b, [orderId]: 'accept' }));
    const prevStatus = orders.find((o) => o.id === orderId)?.status;
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, status: 'CONFIRMED' } : o))
    );
    try {
      await acceptOrder(orderId);
      void unloadChime();
    } catch (e) {
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, status: prevStatus } : o))
      );
      setLoadErr((e as Error).message || 'Accept failed');
    } finally {
      setBusy((b) => ({ ...b, [orderId]: null }));
    }
  };

  const handleDecline = async (orderId: string) => {
    setBusy((b) => ({ ...b, [orderId]: 'decline' }));
    try {
      await declineOrder(orderId);
      void unloadChime();
      // Remove the order from the list — it's terminal (REJECTED_BY_RESTAURANT).
      setOrders((prev) => prev.filter((o) => o.id !== orderId));
    } catch (e) {
      setLoadErr((e as Error).message || 'Decline failed');
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

  // Picker offers Today + the previous 6 IST days. Anything older is
  // rare for a kitchen-floor app; if needed we can extend to 30 days
  // without changing the backend (it accepts any YYYY-MM-DD).
  const datePickerOptions = useMemo(
    () => Array.from({ length: 7 }, (_, n) => istDaysAgo(n)),
    [],
  );

  const openOrder = (id: string) => router.push(`/orders/${encodeURIComponent(id)}`);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }} edges={['left', 'right', 'bottom']}>
      <View style={styles.statusBar}>
        {isLive ? (
          <View style={[styles.pill, pillStyle]}>
            <View style={[styles.dot, { backgroundColor: dotColor }]} />
            <Text style={styles.pillText}>{pillLabel}</Text>
          </View>
        ) : (
          <View style={[styles.pill, styles.pillPast]}>
            <Text style={styles.pillText}>Past — {formatPickerLabel(selectedDate!)}</Text>
          </View>
        )}
        <Pressable
          onPress={() => setDatePickerOpen(true)}
          style={({ pressed }) => [styles.dateBtn, pressed && { opacity: 0.7 }]}
          accessibilityLabel="Pick a date"
        >
          <Text style={styles.dateBtnText}>
            📅 {isLive ? 'Today' : formatPickerLabel(selectedDate!)}
          </Text>
        </Pressable>
        {!isLive && (
          <Pressable
            onPress={() => setSelectedDate(null)}
            style={({ pressed }) => [styles.clearBtn, pressed && { opacity: 0.7 }]}
            accessibilityLabel="Back to live"
          >
            <Text style={styles.clearBtnText}>Live</Text>
          </Pressable>
        )}
        {loadErr && (
          <Pressable onPress={() => setLoadErr(null)} style={styles.errChip}>
            <Text style={styles.errText}>{loadErr}</Text>
          </Pressable>
        )}
      </View>
      {notifPerm === 'denied' ? (
        <Pressable
          onPress={() => { void Linking.openSettings(); }}
          style={({ pressed }) => [styles.permBanner, pressed && { opacity: 0.85 }]}
          accessibilityLabel="Open notification settings"
        >
          <Text style={styles.permBannerTitle}>🔕 Notifications disabled</Text>
          <Text style={styles.permBannerBody}>
            Tap to enable notifications so new orders alert you when the app is closed.
          </Text>
        </Pressable>
      ) : null}
      <FlatList
        data={orders}
        keyExtractor={(o) => o.id}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => openOrder(item.id)}
            android_ripple={{ color: colors.rim }}
            style={({ pressed }) => [pressed && { opacity: 0.85 }]}
            accessibilityLabel={`Open order ${item.order_number || item.id}`}
          >
            <OrderCard
              order={item}
              busyStatus={busy[item.id] || null}
              onStatusChange={handleStatus}
              onAccept={handleAccept}
              onDecline={handleDecline}
              highlight={highlightMap.current.get(item.id)}
            />
          </Pressable>
        )}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {isLive ? 'No active orders' : 'No orders for this day'}
            </Text>
            <Text style={styles.emptySub}>
              {isLive
                ? 'New orders will appear here instantly.'
                : 'Pick a different date or switch back to Live.'}
            </Text>
          </View>
        }
      />
      <DatePickerModal
        visible={datePickerOpen}
        options={datePickerOptions}
        today={today}
        selected={selectedDate}
        onPick={(d) => {
          setSelectedDate(d);
          setDatePickerOpen(false);
        }}
        onClose={() => setDatePickerOpen(false)}
      />
    </SafeAreaView>
  );
}

function DatePickerModal({
  visible,
  options,
  today,
  selected,
  onPick,
  onClose,
}: {
  visible: boolean;
  options: string[];
  today: string;
  selected: string | null;
  onPick: (date: string | null) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        {/* View (not Pressable) so taps inside the card don't bubble
            up to the backdrop dismiss — RN's responder system grants
            the inner touchables (rows, cancel) priority and the View
            itself is non-responsive. */}
        <View style={styles.modalCard} onStartShouldSetResponder={() => true}>
          <Text style={styles.modalTitle}>Pick a date</Text>
          <Pressable
            onPress={() => onPick(null)}
            style={({ pressed }) => [
              styles.modalRow,
              selected === null && styles.modalRowActive,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Text style={styles.modalRowText}>Live (Today)</Text>
            {selected === null ? <Text style={styles.modalCheck}>✓</Text> : null}
          </Pressable>
          {options.map((d) => {
            const isToday = d === today;
            const active = selected === d;
            return (
              <Pressable
                key={d}
                onPress={() => onPick(d)}
                style={({ pressed }) => [
                  styles.modalRow,
                  active && styles.modalRowActive,
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Text style={styles.modalRowText}>
                  {isToday ? 'Today' : formatPickerLabel(d)}
                </Text>
                <Text style={styles.modalRowDate}>{d}</Text>
                {active ? <Text style={styles.modalCheck}>✓</Text> : null}
              </Pressable>
            );
          })}
          <Pressable onPress={onClose} style={styles.modalCancel}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
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
  pillLive: { backgroundColor: primitives.wa.light },
  pillAmber: { backgroundColor: primitives.amber['100'] },
  pillDim: { backgroundColor: primitives.neutral['100'] },
  pillPast: { backgroundColor: primitives.indigo['100'] },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '700', color: colors.tx },
  errChip: {
    backgroundColor: primitives.red['100'], paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 8, flex: 1,
  },
  errText: { color: colors.red, fontSize: 12, fontWeight: '600' },
  list: { padding: 12, paddingBottom: 40 },
  empty: { alignItems: 'center', padding: 40, gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.tx },
  emptySub: { fontSize: 13, color: colors.dim, textAlign: 'center' },
  dateBtn: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99,
    borderWidth: 1, borderColor: colors.rim, backgroundColor: colors.ink,
  },
  dateBtnText: { fontSize: 12, fontWeight: '700', color: colors.tx },
  clearBtn: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99,
    backgroundColor: colors.acc,
  },
  clearBtnText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  modalBackdrop: {
    flex: 1, backgroundColor: colors.overlayModal,
    alignItems: 'center', justifyContent: 'center', padding: 20,
  },
  modalCard: {
    width: '100%', maxWidth: 360,
    backgroundColor: colors.ink2, borderRadius: 14,
    borderWidth: 1, borderColor: colors.rim,
    padding: 14, gap: 4,
  },
  modalTitle: {
    fontSize: 16, fontWeight: '800', color: colors.tx,
    marginBottom: 8, paddingHorizontal: 4,
  },
  modalRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 12,
    borderRadius: 10,
  },
  modalRowActive: { backgroundColor: colors.accGlow },
  modalRowText: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.tx },
  modalRowDate: { fontSize: 12, color: colors.dim },
  modalCheck: { fontSize: 16, color: colors.acc, fontWeight: '800' },
  modalCancel: { paddingVertical: 12, paddingHorizontal: 12, marginTop: 6, alignItems: 'center' },
  modalCancelText: { fontSize: 14, color: colors.dim, fontWeight: '600' },
  permBanner: {
    marginHorizontal: 12, marginTop: 10,
    padding: 12, borderRadius: 12,
    // borderColor: Tailwind amber-300 (#fcd34d) — NOT a primitive in
    // @gullybite/design-tokens (it's only an @theme anchor in
    // global.css). Left inline; flagged for a Part 2 amendment.
    backgroundColor: primitives.amber['100'], borderWidth: 1, borderColor: '#fcd34d',
    gap: 4,
  },
  permBannerTitle: { fontSize: 13, fontWeight: '800', color: primitives.amber['900'] },
  permBannerBody: { fontSize: 12, color: primitives.amber['900'] },
});
