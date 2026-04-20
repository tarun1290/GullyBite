// One order card, optimised for glanceability from a kitchen counter.
// The next-status action row is driven by NEXT_ACTIONS so the same
// component serves both the initial fetch and live SSE inserts.

import { memo } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { StaffOrder } from '@/api';
import { badgeFor, colors } from '@/theme';
import { formatRs, timeAgo } from '@/time';

const NEXT_ACTIONS: Record<
  string,
  Array<{ label: string; to: string; kind?: 'danger' | 'primary' }>
> = {
  PENDING_PAYMENT: [
    { label: 'Confirm', to: 'confirmed', kind: 'primary' },
    { label: 'Cancel', to: 'cancelled', kind: 'danger' },
  ],
  pending: [
    { label: 'Confirm', to: 'confirmed', kind: 'primary' },
    { label: 'Cancel', to: 'cancelled', kind: 'danger' },
  ],
  CONFIRMED: [{ label: 'Preparing', to: 'preparing', kind: 'primary' }],
  confirmed: [{ label: 'Preparing', to: 'preparing', kind: 'primary' }],
  PREPARING: [{ label: 'Ready', to: 'ready', kind: 'primary' }],
  preparing: [{ label: 'Ready', to: 'ready', kind: 'primary' }],
  PACKED: [{ label: 'Out for Delivery', to: 'out_for_delivery', kind: 'primary' }],
  ready: [{ label: 'Out for Delivery', to: 'out_for_delivery', kind: 'primary' }],
  DISPATCHED: [{ label: 'Delivered', to: 'delivered', kind: 'primary' }],
  out_for_delivery: [{ label: 'Delivered', to: 'delivered', kind: 'primary' }],
};

type Props = {
  order: StaffOrder;
  busyStatus?: string | null;
  onStatusChange: (orderId: string, toStatus: string) => void;
  highlight?: Animated.Value;
};

function OrderCardBase({ order, busyStatus, onStatusChange, highlight }: Props) {
  const badge = badgeFor(order.status);
  const phoneTail = (order.customer_phone_masked || '').slice(-4);
  const actions = NEXT_ACTIONS[order.status || ''] || [];
  const items = Array.isArray(order.items) ? order.items : [];

  const bg = highlight
    ? highlight.interpolate({
        inputRange: [0, 1],
        outputRange: [colors.ink2, colors.accGlow],
      })
    : (colors.ink2 as unknown as Animated.AnimatedInterpolation<string>);

  return (
    <Animated.View style={[styles.card, { backgroundColor: bg as any }]}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.orderNum}>
            Order #{order.order_number || order.id.slice(0, 6)}
          </Text>
          <Text style={styles.meta}>
            {timeAgo(order.created_at)}
            {phoneTail ? ` · Phone ****${phoneTail}` : ''}
          </Text>
        </View>
        <View style={[styles.badge, { backgroundColor: badge.bg }]}>
          <Text style={[styles.badgeText, { color: badge.fg }]}>{badge.label}</Text>
        </View>
      </View>

      <View style={styles.items}>
        {items.length === 0 && <Text style={styles.itemDim}>No items listed</Text>}
        {items.map((it, i) => {
          const qty = it.qty ?? it.quantity ?? 1;
          return (
            <Text key={i} style={styles.item}>
              {qty}× {it.name || 'Item'}
            </Text>
          );
        })}
      </View>

      <View style={styles.footerRow}>
        <Text style={styles.total}>{formatRs(order.total_rs ?? null)}</Text>
        <View style={styles.actions}>
          {actions.map((a) => {
            const busy = busyStatus === a.to;
            return (
              <Pressable
                key={a.to}
                onPress={() => onStatusChange(order.id, a.to)}
                disabled={!!busyStatus}
                style={({ pressed }) => [
                  styles.btn,
                  a.kind === 'danger' && styles.btnDanger,
                  a.kind === 'primary' && styles.btnPrimary,
                  pressed && { opacity: 0.8 },
                  !!busyStatus && { opacity: 0.6 },
                ]}
              >
                <Text
                  style={[
                    styles.btnText,
                    (a.kind === 'primary' || a.kind === 'danger') && styles.btnTextInv,
                  ]}
                >
                  {busy ? '…' : a.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </Animated.View>
  );
}

export const OrderCard = memo(OrderCardBase);

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink2,
    borderWidth: 1, borderColor: colors.rim, borderRadius: 14,
    padding: 14, marginBottom: 10,
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 10 },
  orderNum: { fontSize: 18, fontWeight: '800', color: colors.tx, letterSpacing: -0.3 },
  meta: { fontSize: 12, color: colors.dim, fontWeight: '600', marginTop: 2 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99 },
  badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.2 },
  items: { gap: 4, marginBottom: 10 },
  item: { fontSize: 14, color: colors.tx },
  itemDim: { fontSize: 13, color: colors.mute, fontStyle: 'italic' },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  total: { fontSize: 22, fontWeight: '800', color: colors.tx },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  btn: {
    backgroundColor: colors.ink2,
    borderWidth: 1, borderColor: colors.rim,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 10, minHeight: 44, justifyContent: 'center',
  },
  btnPrimary: { backgroundColor: colors.acc, borderColor: colors.acc },
  btnDanger: { backgroundColor: colors.red, borderColor: colors.red },
  btnText: { fontSize: 13, fontWeight: '700', color: colors.tx },
  btnTextInv: { color: '#fff' },
});
