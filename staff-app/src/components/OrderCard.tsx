// One order card, optimised for glanceability from a kitchen counter.
// The next-status action row is driven by NEXT_ACTIONS so the same
// component serves both the initial fetch and live SSE inserts.

import { memo } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { StaffOrder } from '@/api';
import { useAuth } from '@/store/authStore';
import { badgeFor, colors, fontWeight, primitives, radius, space, text } from '@/theme';
import { formatRs, timeAgo } from '@/time';

// PAID orders go through the dedicated /accept and /decline endpoints
// (they need refund + token-cancel side effects on decline). Staff
// cannot transition a PAID order via the generic /status endpoint —
// that's restricted server-side to CONFIRMED → PREPARING → PACKED.
//
// CONFIRMED+ orders use NEXT_ACTIONS below + onStatusChange callback.
const NEXT_ACTIONS: Record<
  string,
  Array<{ label: string; to: string; kind?: 'danger' | 'primary' }>
> = {
  CONFIRMED: [{ label: 'Preparing', to: 'preparing', kind: 'primary' }],
  confirmed: [{ label: 'Preparing', to: 'preparing', kind: 'primary' }],
  PREPARING: [{ label: 'Ready', to: 'ready', kind: 'primary' }],
  preparing: [{ label: 'Ready', to: 'ready', kind: 'primary' }],
  // PACKED is terminal for staff — Prorouting handles dispatch from here.
};

type Props = {
  order: StaffOrder;
  busyStatus?: string | null;
  onStatusChange: (orderId: string, toStatus: string) => void;
  // PAID-specific callbacks. Parent provides them so OrderCard stays
  // free of API imports (testable in isolation).
  onAccept?: (orderId: string) => void;
  onDecline?: (orderId: string) => void;
  highlight?: Animated.Value;
  // Permission gates (2026-05-09 staff-auth refactor). Each flag, when
  // true, hides the corresponding action button without affecting any
  // other layout. Defaults to false (button visible) to keep callers
  // that haven't migrated to the permission-aware flow rendering as
  // before.
  hideAccept?: boolean;
  hideDecline?: boolean;
  hideNextStatus?: boolean;
};

function OrderCardBase({
  order,
  busyStatus,
  onStatusChange,
  onAccept,
  onDecline,
  highlight,
  hideAccept,
  hideDecline,
  hideNextStatus,
}: Props) {
  const { currentBranchId, staffUser } = useAuth();
  const badge = badgeFor(order.status);
  const phoneTail = (order.customer_phone_masked || '').slice(-4);
  const status = String(order.status || '').toUpperCase();
  const isPaid = status === 'PAID';
  const actions = isPaid ? [] : (NEXT_ACTIONS[order.status || ''] || []);
  const items = Array.isArray(order.items) ? order.items : [];

  // Branch tag — only when the operator is in the multi-branch
  // "All Branches" view AND has more than one branch assigned (a
  // single-branch operator would never see anything else, so the chip
  // would just be visual noise). Resolves the order's branch_id to a
  // human-readable name from the staffUser.branches list (sourced in
  // /api/staff/auth's response). Falls back to a short id slice if the
  // branch was deleted but still referenced by the order.
  const branches = staffUser?.branches || [];
  const showBranchTag = currentBranchId === 'all' && branches.length > 1 && !!order.branch_id;
  const branchName = showBranchTag
    ? (branches.find((b) => b.id === order.branch_id)?.name
        || (order.branch_id ? `${String(order.branch_id).slice(0, 6)}…` : ''))
    : null;

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
          {branchName ? (
            <View style={styles.branchTag}>
              <Text style={styles.branchTagText} numberOfLines={1}>📍 {branchName}</Text>
            </View>
          ) : null}
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
        <Text style={styles.total}>{formatRs(order.total_rs ?? order.total_amount ?? null)}</Text>
        <View style={styles.actions}>
          {isPaid ? (
            <>
              {hideAccept ? null : (
                <Pressable
                  onPress={() => onAccept?.(order.id)}
                  disabled={!!busyStatus}
                  style={({ pressed }) => [
                    styles.btn, styles.btnPrimary,
                    pressed && { opacity: 0.8 },
                    !!busyStatus && { opacity: 0.6 },
                  ]}
                >
                  <Text style={[styles.btnText, styles.btnTextInv]}>
                    {busyStatus === 'accept' ? '…' : 'Accept'}
                  </Text>
                </Pressable>
              )}
              {hideDecline ? null : (
                <Pressable
                  onPress={() => onDecline?.(order.id)}
                  disabled={!!busyStatus}
                  style={({ pressed }) => [
                    styles.btn, styles.btnDanger,
                    pressed && { opacity: 0.8 },
                    !!busyStatus && { opacity: 0.6 },
                  ]}
                >
                  <Text style={[styles.btnText, styles.btnTextInv]}>
                    {busyStatus === 'decline' ? '…' : 'Decline'}
                  </Text>
                </Pressable>
              )}
            </>
          ) : hideNextStatus ? null : (
            actions.map((a) => {
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
            })
          )}
        </View>
      </View>
    </Animated.View>
  );
}

export const OrderCard = memo(OrderCardBase);

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink2,
    borderWidth: 1, borderColor: colors.rim, borderRadius: radius['2xl'], // was 14, rounded to 16 (2xl)
    padding: space.px4, marginBottom: space.px3, // was padding 14, rounded to 16 (px4); marginBottom 10, rounded to 12 (px3)
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: space.px3, gap: space.px3 }, // was marginBottom 10, rounded to 12 (px3); gap 10, rounded to 12 (px3)
  orderNum: { fontSize: text.lg, fontWeight: fontWeight.extrabold, color: colors.tx, letterSpacing: -0.3 }, // was 18, rounded to 17 (lg)
  meta: { fontSize: text.xs, color: colors.dim, fontWeight: fontWeight.semibold, marginTop: space.px1 }, // was fontSize 12, rounded to 11.5 (xs); marginTop 2, rounded to 4 (px1)
  // RN translation of `text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full`
  // from the brief. alignSelf: 'flex-start' keeps the chip from
  // stretching across the full card width when the order_number is short.
  branchTag: {
    alignSelf: 'flex-start',
    backgroundColor: primitives.neutral['100'],
    paddingHorizontal: space.px2,
    paddingVertical: space.px1, // was 2, rounded to 4 (px1)
    borderRadius: radius.full, // fixes audit §3.5 typo: was 999 (intended 99 / pill); radius.full (9999) is the canonical pill token
    marginTop: space.px2, // was 6, rounded to 8 (px2)
    maxWidth: '100%',
  },
  branchTagText: { fontSize: text.xs, color: primitives.neutral['700'], fontWeight: fontWeight.semibold }, // was 11, rounded to 11.5 (xs)
  badge: { paddingHorizontal: space.px3, paddingVertical: space.px1, borderRadius: 99 }, // was paddingHorizontal 10, rounded to 12 (px3); paddingVertical 4 (px1, exact); off-scale radius: 99 (intentional pill, kept as-is)
  badgeText: { fontSize: text.xs, fontWeight: fontWeight.bold, letterSpacing: 0.2 }, // was 11, rounded to 11.5 (xs)
  items: { gap: space.px1, marginBottom: space.px3 }, // was marginBottom 10, rounded to 12 (px3)
  item: { fontSize: text.base, color: colors.tx },
  itemDim: { fontSize: text.sm, color: colors.mute, fontStyle: 'italic' },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: space.px2 },
  total: { fontSize: text.xl, fontWeight: fontWeight.extrabold, color: colors.tx }, // was 22, rounded to 20 (xl)
  actions: { flexDirection: 'row', gap: space.px2, flexWrap: 'wrap' },
  btn: {
    backgroundColor: colors.ink2,
    borderWidth: 1, borderColor: colors.rim,
    paddingHorizontal: space.px4, paddingVertical: space.px3, // was paddingHorizontal 14, rounded to 16 (px4); paddingVertical 10, rounded to 12 (px3)
    borderRadius: radius.lg, minHeight: 44, justifyContent: 'center',
  },
  btnPrimary: { backgroundColor: colors.acc, borderColor: colors.acc },
  btnDanger: { backgroundColor: colors.red, borderColor: colors.red },
  btnText: { fontSize: text.sm, fontWeight: fontWeight.bold, color: colors.tx },
  btnTextInv: { color: '#fff' },
});
