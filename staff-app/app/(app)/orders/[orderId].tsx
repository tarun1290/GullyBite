// Order detail. Action buttons depend on current status:
//   PAID       → Accept (primary) + Decline (destructive)
//   CONFIRMED  → Mark as Preparing
//   PREPARING  → Mark as Packed
//   PACKED     → text only ("Awaiting rider assignment")
//
// Customer phone is masked — never show full digits. The order is
// re-fetched via getOrders() on mount so the screen works after a deep
// link or app restart, not just from the orders-list nav.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import {
  acceptOrder,
  declineOrder,
  getOrders,
  updateOrderStatus,
  type StaffOrder,
  type StaffOrderItem,
} from '@/api';
import { unloadChime } from '@/sound';
import { colors } from '@/theme';

type ActionKind = 'accept' | 'decline' | 'preparing' | 'packed' | null;

function formatRs(n: number | null | undefined): string {
  const v = Number(n) || 0;
  return `₹${v.toFixed(0)}`;
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function maskPhone(p?: string): string {
  if (!p) return '';
  // Show only last 2 digits, mask the rest. Defensive: input may
  // already be server-masked.
  const digits = String(p).replace(/[^0-9]/g, '');
  if (digits.length <= 2) return digits;
  const tail = digits.slice(-2);
  return `${'X'.repeat(digits.length - 2)}${tail}`;
}

export default function OrderDetailScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<StaffOrder | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [action, setAction] = useState<ActionKind>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await getOrders();
      const found = res.orders.find((o) => String(o.id) === String(orderId));
      setOrder(found || null);
      if (!found) setErr('Order not found');
    } catch (e) {
      setErr((e as Error).message || 'Failed to load order');
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { refetch(); }, [refetch]);

  const onAccept = async () => {
    if (action) return;
    setAction('accept');
    try {
      await acceptOrder(String(orderId));
      await unloadChime();
      router.back();
    } catch (e) {
      Alert.alert('Accept failed', (e as Error).message || 'Please retry.');
    } finally {
      setAction(null);
    }
  };

  const onDecline = () => {
    Alert.alert(
      'Decline order?',
      'Are you sure you want to decline this order? The customer will be refunded.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Decline',
          style: 'destructive',
          onPress: async () => {
            if (action) return;
            setAction('decline');
            try {
              await declineOrder(String(orderId));
              await unloadChime();
              router.back();
            } catch (e) {
              Alert.alert('Decline failed', (e as Error).message || 'Please retry.');
            } finally {
              setAction(null);
            }
          },
        },
      ],
    );
  };

  const onMarkPreparing = async () => {
    if (action) return;
    setAction('preparing');
    try {
      await updateOrderStatus(String(orderId), 'preparing');
      router.back();
    } catch (e) {
      Alert.alert('Status update failed', (e as Error).message || 'Please retry.');
    } finally {
      setAction(null);
    }
  };

  const onMarkPacked = async () => {
    if (action) return;
    setAction('packed');
    try {
      await updateOrderStatus(String(orderId), 'packed');
      router.back();
    } catch (e) {
      Alert.alert('Status update failed', (e as Error).message || 'Please retry.');
    } finally {
      setAction(null);
    }
  };

  if (loading && !order) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={colors.acc} />
      </SafeAreaView>
    );
  }
  if (err || !order) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.errText}>{err || 'Order not found'}</Text>
        <Pressable style={styles.btnGhost} onPress={refetch}>
          <Text style={styles.btnGhostText}>Retry</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const status = String(order.status || '').toUpperCase();
  const items: StaffOrderItem[] = Array.isArray(order.items) ? order.items : [];
  const itemCount = items.reduce((s, i) => s + (Number(i.quantity ?? i.qty) || 0), 0);
  const total = order.total_amount ?? order.total_rs ?? null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.header}>
          <Text style={styles.orderNumber}>#{order.order_number || order.id}</Text>
          <View style={[styles.badge, badgeStyleFor(status)]}>
            <Text style={styles.badgeText}>{status || '—'}</Text>
          </View>
        </View>
        <Text style={styles.time}>Received {formatTime(order.created_at)}</Text>

        <Section title="Customer">
          <Text style={styles.row}>{order.customer_name || 'Customer'}</Text>
          {order.customer_phone_masked ? (
            <Text style={styles.rowDim}>{order.customer_phone_masked}</Text>
          ) : null}
        </Section>

        <Section title={`Items (${itemCount})`}>
          {items.length === 0 ? (
            <Text style={styles.rowDim}>No items in this order.</Text>
          ) : (
            items.map((it, i) => (
              <View key={String(it.id ?? i)} style={styles.itemRow}>
                <Text style={styles.itemQty}>{Number(it.quantity ?? it.qty) || 0}×</Text>
                <Text style={styles.itemName}>{it.name || '—'}</Text>
              </View>
            ))
          )}
        </Section>

        <Section title="Total">
          <Text style={styles.totalText}>{formatRs(total)}</Text>
        </Section>

        {/* Action row — based on current status */}
        <View style={{ height: 16 }} />
        {status === 'PAID' && (
          <View style={styles.actionCol}>
            <Pressable
              onPress={onAccept}
              disabled={!!action}
              style={({ pressed }) => [styles.btnPrimary, action && styles.btnDisabled, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.btnPrimaryText}>{action === 'accept' ? 'Accepting…' : 'Accept'}</Text>
            </Pressable>
            <Pressable
              onPress={onDecline}
              disabled={!!action}
              style={({ pressed }) => [styles.btnDanger, action && styles.btnDisabled, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.btnDangerText}>{action === 'decline' ? 'Declining…' : 'Decline'}</Text>
            </Pressable>
          </View>
        )}
        {status === 'CONFIRMED' && (
          <Pressable
            onPress={onMarkPreparing}
            disabled={!!action}
            style={({ pressed }) => [styles.btnPrimary, action && styles.btnDisabled, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.btnPrimaryText}>{action === 'preparing' ? 'Updating…' : 'Mark as Preparing'}</Text>
          </Pressable>
        )}
        {status === 'PREPARING' && (
          <Pressable
            onPress={onMarkPacked}
            disabled={!!action}
            style={({ pressed }) => [styles.btnPrimary, action && styles.btnDisabled, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.btnPrimaryText}>{action === 'packed' ? 'Updating…' : 'Mark as Packed'}</Text>
          </Pressable>
        )}
        {status === 'PACKED' && (
          <Text style={styles.terminal}>Awaiting rider assignment</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function badgeStyleFor(status: string) {
  switch (status) {
    case 'PAID':       return { backgroundColor: '#fef3c7' };
    case 'CONFIRMED':  return { backgroundColor: '#dbeafe' };
    case 'PREPARING':  return { backgroundColor: '#fed7aa' };
    case 'PACKED':     return { backgroundColor: '#dcfce7' };
    default:           return { backgroundColor: '#f3f4f6' };
  }
}

const styles = StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.ink, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  orderNumber: { fontSize: 22, fontWeight: '800', color: colors.tx },
  time: { fontSize: 12, color: colors.dim },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99 },
  badgeText: { fontSize: 11, fontWeight: '800', color: colors.tx, letterSpacing: 0.4 },
  section: {
    backgroundColor: colors.ink2, borderWidth: 1, borderColor: colors.rim,
    borderRadius: 12, padding: 12, gap: 6,
  },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: colors.dim, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { fontSize: 14, color: colors.tx, fontWeight: '600' },
  rowDim: { fontSize: 13, color: colors.dim },
  itemRow: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 4 },
  itemQty: { fontSize: 13, color: colors.dim, fontWeight: '700', minWidth: 32 },
  itemName: { fontSize: 14, color: colors.tx, flex: 1 },
  totalText: { fontSize: 22, fontWeight: '800', color: colors.tx },
  actionCol: { gap: 10 },
  btnPrimary: {
    backgroundColor: colors.acc, paddingVertical: 14, borderRadius: 12, alignItems: 'center',
  },
  btnPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  btnDanger: {
    backgroundColor: colors.red, paddingVertical: 14, borderRadius: 12, alignItems: 'center',
  },
  btnDangerText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  btnGhost: {
    paddingVertical: 12, paddingHorizontal: 18, borderRadius: 10,
    borderWidth: 1, borderColor: colors.rim,
  },
  btnGhostText: { color: colors.tx, fontSize: 14, fontWeight: '600' },
  btnDisabled: { opacity: 0.6 },
  errText: { color: colors.red, fontSize: 14, fontWeight: '600' },
  terminal: { textAlign: 'center', fontSize: 13, color: colors.dim, fontStyle: 'italic' },
});
