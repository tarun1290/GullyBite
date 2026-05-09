// Order detail. Action buttons depend on current status:
//   PAID       → Accept (primary) + Decline (destructive)
//   CONFIRMED  → Mark as Preparing
//   PREPARING  → Mark as Packed
//   PACKED+    → text only (no action — DISPATCHED/DELIVERED/etc. are
//                terminal-for-staff)
//
// Customer phone is masked — never show full digits. The order is
// fetched via getOrder(id) on mount, which hits the dedicated
// /api/staff/orders/:orderId endpoint so the screen works for past
// orders (date view) and orders that have moved beyond PACKED, not
// just for orders that are currently in the live list.

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
  getOrder,
  updateOrderStatus,
  type StaffOrder,
  type StaffOrderItem,
} from '@/api';
import { useStaffPermissions } from '@/state/StaffContext';
import { unloadChime } from '@/sound';
import { badgeFor, colors, space, text, radius, fontWeight } from '@/theme';

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

export default function OrderDetailScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<StaffOrder | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [action, setAction] = useState<ActionKind>(null);
  // Permission gates (2026-05-09 staff-auth refactor). Each flag drives
  // whether a specific action button is rendered. canViewOrders also
  // flips the entire detail body off in favor of an inline "No access"
  // surface to mirror the list screen's behavior.
  const {
    canViewOrders,
    canAcceptOrders,
    canRejectOrders,
    canMarkReady,
  } = useStaffPermissions();

  const refetch = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await getOrder(String(orderId));
      setOrder(res.order || null);
      if (!res.order) setErr('Order not found');
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
  if (!canViewOrders) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }}>
        <View style={styles.noAccessWrap}>
          <View style={styles.noAccessCard}>
            <Text style={styles.noAccessTitle}>No access</Text>
            <Text style={styles.noAccessBody}>
              Your account doesn’t have permission to view orders. Ask
              your manager to enable “View orders” for your role.
            </Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const status = String(order.status || '').toUpperCase();
  const items: StaffOrderItem[] = Array.isArray(order.items) ? order.items : [];
  const itemCount = items.reduce((s, i) => s + (Number(i.quantity ?? i.qty) || 0), 0);
  const total = order.total_amount ?? order.total_rs ?? null;
  const subtotal = order.subtotal_rs ?? null;
  const deliveryFee = order.delivery_fee_rs ?? null;
  const discount = order.discount_rs ?? null;
  const paymentStatus = order.payment_status ? String(order.payment_status) : null;
  // Terminal states from the staff perspective — no actions, just a
  // descriptive label. PACKED is the staff's last actionable state;
  // anything past it (DISPATCHED, DELIVERED) or any fault state
  // (CANCELLED, REJECTED_BY_RESTAURANT, etc.) renders as terminal.
  const STAFF_TERMINAL_LABEL: Record<string, string> = {
    PACKED: 'Awaiting rider assignment',
    DISPATCHED: 'Out for delivery',
    DELIVERED: 'Delivered',
    CANCELLED: 'Cancelled',
    REJECTED_BY_RESTAURANT: 'Rejected',
    RESTAURANT_TIMEOUT: 'Timed out',
    EXPIRED: 'Expired',
    EXPIRED_PAYMENT: 'Expired (refunded)',
    NO_DELIVERY_AVAILABLE: 'No delivery available',
  };
  const terminalLabel = STAFF_TERMINAL_LABEL[status] || null;
  const isStaffActionable = status === 'PAID' || status === 'CONFIRMED' || status === 'PREPARING';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.header}>
          <Text style={styles.orderNumber}>#{order.order_number || order.id}</Text>
          <View style={[styles.badge, { backgroundColor: badgeFor(status).bg }]}>
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

        <Section title="Totals">
          {subtotal != null ? (
            <View style={styles.lineRow}>
              <Text style={styles.lineLabel}>Subtotal</Text>
              <Text style={styles.lineValue}>{formatRs(subtotal)}</Text>
            </View>
          ) : null}
          {deliveryFee != null ? (
            <View style={styles.lineRow}>
              <Text style={styles.lineLabel}>Delivery</Text>
              <Text style={styles.lineValue}>{formatRs(deliveryFee)}</Text>
            </View>
          ) : null}
          {discount != null && Number(discount) > 0 ? (
            <View style={styles.lineRow}>
              <Text style={styles.lineLabel}>Discount</Text>
              <Text style={styles.lineValue}>−{formatRs(discount)}</Text>
            </View>
          ) : null}
          <View style={styles.lineRow}>
            <Text style={styles.lineLabelStrong}>Total</Text>
            <Text style={styles.totalText}>{formatRs(total)}</Text>
          </View>
          {paymentStatus ? (
            <Text style={styles.rowDim}>Payment: {paymentStatus}</Text>
          ) : null}
        </Section>

        {/* Action row — based on current status. Buttons are
            additionally gated by the 10-key permission set sourced from
            useStaffPermissions(): Accept/Decline by accept_orders /
            reject_orders, Mark Preparing/Packed by mark_ready. */}
        <View style={{ height: 16 }} />
        {status === 'PAID' && (canAcceptOrders || canRejectOrders) && (
          <View style={styles.actionCol}>
            {canAcceptOrders && (
              <Pressable
                onPress={onAccept}
                disabled={!!action}
                style={({ pressed }) => [styles.btnPrimary, action && styles.btnDisabled, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.btnPrimaryText}>{action === 'accept' ? 'Accepting…' : 'Accept'}</Text>
              </Pressable>
            )}
            {canRejectOrders && (
              <Pressable
                onPress={onDecline}
                disabled={!!action}
                style={({ pressed }) => [styles.btnDanger, action && styles.btnDisabled, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.btnDangerText}>{action === 'decline' ? 'Declining…' : 'Decline'}</Text>
              </Pressable>
            )}
          </View>
        )}
        {status === 'CONFIRMED' && canMarkReady && (
          <Pressable
            onPress={onMarkPreparing}
            disabled={!!action}
            style={({ pressed }) => [styles.btnPrimary, action && styles.btnDisabled, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.btnPrimaryText}>{action === 'preparing' ? 'Updating…' : 'Mark as Preparing'}</Text>
          </Pressable>
        )}
        {status === 'PREPARING' && canMarkReady && (
          <Pressable
            onPress={onMarkPacked}
            disabled={!!action}
            style={({ pressed }) => [styles.btnPrimary, action && styles.btnDisabled, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.btnPrimaryText}>{action === 'packed' ? 'Updating…' : 'Mark as Packed'}</Text>
          </Pressable>
        )}
        {!isStaffActionable && terminalLabel ? (
          <Text style={styles.terminal}>{terminalLabel}</Text>
        ) : null}
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

const styles = StyleSheet.create({
  scroll: { padding: space.px4, paddingBottom: space.px10, gap: space.px3 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.ink, gap: space.px3 },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.px3 }, // was 10, rounded to 12 (px3)
  orderNumber: { fontSize: text.xl, fontWeight: fontWeight.extrabold, color: colors.tx }, // was 22, rounded to 20 (xl)
  time: { fontSize: text.xs, color: colors.dim }, // was 12, rounded to 11.5 (xs)
  badge: { paddingHorizontal: space.px3, paddingVertical: space.px1, borderRadius: 99 }, // off-scale radius: 99 — was 10, rounded to 12 (px3)
  badgeText: { fontSize: text.xs, fontWeight: fontWeight.extrabold, color: colors.tx, letterSpacing: 0.4 }, // was 11, rounded to 11.5 (xs)
  section: {
    backgroundColor: colors.ink2, borderWidth: 1, borderColor: colors.rim,
    borderRadius: radius.xl, padding: space.px3, gap: space.px2, // was 6, rounded to 8 (px2)
  },
  sectionTitle: { fontSize: text.xs, fontWeight: fontWeight.bold, color: colors.dim, textTransform: 'uppercase', letterSpacing: 0.5 }, // was 11, rounded to 11.5 (xs)
  row: { fontSize: text.base, color: colors.tx, fontWeight: fontWeight.semibold },
  rowDim: { fontSize: text.sm, color: colors.dim },
  itemRow: { flexDirection: 'row', gap: space.px3, alignItems: 'center', paddingVertical: space.px1 }, // was 10, rounded to 12 (px3)
  itemQty: { fontSize: text.sm, color: colors.dim, fontWeight: fontWeight.bold, minWidth: 32 },
  itemName: { fontSize: text.base, color: colors.tx, flex: 1 },
  totalText: { fontSize: text.xl, fontWeight: fontWeight.extrabold, color: colors.tx },
  lineRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.px1 }, // was 2, rounded to 4 (px1)
  lineLabel: { fontSize: text.sm, color: colors.dim },
  lineLabelStrong: { fontSize: text.base, color: colors.tx, fontWeight: fontWeight.bold },
  lineValue: { fontSize: text.sm, color: colors.tx, fontWeight: fontWeight.semibold },
  actionCol: { gap: space.px3 }, // was 10, rounded to 12 (px3)
  btnPrimary: {
    backgroundColor: colors.acc, paddingVertical: space.px4, borderRadius: radius.xl, alignItems: 'center', // was 14, rounded to 16 (px4)
  },
  btnPrimaryText: { color: colors.ink2, fontSize: text.lg, fontWeight: fontWeight.bold }, // was 16, rounded to 17 (lg)
  btnDanger: {
    backgroundColor: colors.red, paddingVertical: space.px4, borderRadius: radius.xl, alignItems: 'center', // was 14, rounded to 16 (px4)
  },
  btnDangerText: { color: colors.ink2, fontSize: text.lg, fontWeight: fontWeight.bold }, // was 16, rounded to 17 (lg)
  btnGhost: {
    paddingVertical: space.px3, paddingHorizontal: space.px4, borderRadius: radius.lg, // was 18, rounded to 16 (px4)
    borderWidth: 1, borderColor: colors.rim,
  },
  btnGhostText: { color: colors.tx, fontSize: text.base, fontWeight: fontWeight.semibold },
  btnDisabled: { opacity: 0.6 },
  errText: { color: colors.red, fontSize: text.base, fontWeight: fontWeight.semibold },
  terminal: { textAlign: 'center', fontSize: text.sm, color: colors.dim, fontStyle: 'italic' },
  noAccessWrap: { flex: 1, padding: space.px4, justifyContent: 'flex-start' },
  noAccessCard: {
    backgroundColor: colors.ink2, borderWidth: 1, borderColor: colors.rim,
    borderRadius: radius.xl, padding: space.px4, gap: space.px2,
  },
  noAccessTitle: { fontSize: text.lg, fontWeight: fontWeight.extrabold, color: colors.tx },
  noAccessBody: { fontSize: text.sm, color: colors.dim, lineHeight: 20 },
});
