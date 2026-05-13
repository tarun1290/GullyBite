// Staff manual dine-in check-in.
//
// Single screen, no nested stack: staff types a customer phone, picks
// a branch (auto when only one), taps Check In → POST to
// /api/restaurant/dine-in/checkin (source: 'staff'). The backend
// upserts the customer, inserts a dine_in_visits row, increments points,
// and fires the dine_in_checkin journey from the marketing number. On
// success we show a confirmation card with visit # / points balance /
// optional name + milestone, then auto-reset after 4s so the next
// customer can be checked in quickly.
//
// Branch resolution: if the staff JWT carries multiple branch_ids, the
// global header BranchSelector (mounted in (app)/_layout.tsx) decides
// which branch the check-in lands on — same plumbing as orders. When
// the operator has 'all' selected, we fall back to staffUser.branchId
// (the primary assignment) and surface a small hint so it isn't a
// silent decision. Single-branch sessions skip every selector entirely.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { checkInDineIn, type DineInCheckinResponse } from '@/api';
import { useStaff } from '@/state/StaffContext';
import { colors, fontWeight, radius, space, text } from '@/theme';

// Strip everything but digits and clamp to 15 (E.164 max). Phone is
// always sent to the backend as digits — formatting is purely visual.
function digitsOnly(input: string): string {
  return (input || '').replace(/\D/g, '').slice(0, 15);
}

// Visual formatting: Indian numbers (10 digits, or 12 with 91 prefix)
// get spaced for readability — e.g. "91 98765 43210". Other lengths
// fall back to raw digits so we don't mangle international numbers
// staff might enter.
function formatPhoneForDisplay(digits: string): string {
  if (!digits) return '';
  if (digits.startsWith('91') && digits.length > 2) {
    const rest = digits.slice(2);
    if (rest.length <= 5) return `91 ${rest}`;
    return `91 ${rest.slice(0, 5)} ${rest.slice(5)}`;
  }
  if (digits.length === 10) {
    return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  return digits;
}

const SUCCESS_AUTO_RESET_MS = 4000;

export default function DineInCheckinScreen() {
  const { staffUser, currentBranchId } = useStaff();

  // Phone state stored as the raw digit stream; the visible TextInput
  // value is derived through formatPhoneForDisplay so we never have to
  // strip formatting on submit.
  const [phoneDigits, setPhoneDigits] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<DineInCheckinResponse | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const branches = staffUser?.branches || [];
  const branchIds = staffUser?.branchIds || (staffUser?.branchId ? [staffUser.branchId] : []);
  const multiBranch = branchIds.length > 1;

  // Effective branch the check-in will be recorded against:
  //   • Multi-branch + specific selection → use that id.
  //   • Multi-branch + 'all' (or null) → fall back to primary
  //     staffUser.branchId so the request is never sent without a
  //     branch_id. The hint below tells the operator which branch
  //     was chosen so the fallback isn't silent.
  //   • Single-branch session → staffUser.branchId.
  const effectiveBranchId = useMemo<string | null>(() => {
    if (multiBranch && currentBranchId && currentBranchId !== 'all') return currentBranchId;
    return staffUser?.branchId || null;
  }, [multiBranch, currentBranchId, staffUser?.branchId]);

  const effectiveBranchName = useMemo<string>(() => {
    if (!effectiveBranchId) return '';
    return branches.find((b) => b.id === effectiveBranchId)?.name || '';
  }, [branches, effectiveBranchId]);

  // Cleanup any pending auto-reset timer on unmount so a navigate-away
  // mid-success doesn't leave a setTimeout firing on a stale closure.
  useEffect(() => {
    return () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
        resetTimer.current = null;
      }
    };
  }, []);

  function clearResetTimer() {
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
  }

  function resetFormToFresh() {
    setPhoneDigits('');
    setErrorMsg(null);
    setResult(null);
    clearResetTimer();
  }

  function scheduleAutoReset() {
    clearResetTimer();
    resetTimer.current = setTimeout(() => {
      resetFormToFresh();
    }, SUCCESS_AUTO_RESET_MS);
  }

  const canSubmit = phoneDigits.length >= 10 && !submitting && !!effectiveBranchId;

  async function onSubmit() {
    if (!canSubmit || !effectiveBranchId) return;
    setSubmitting(true);
    setErrorMsg(null);
    setResult(null);
    try {
      const res = await checkInDineIn({
        phone: phoneDigits,
        branch_id: effectiveBranchId,
      });
      setResult(res);
      scheduleAutoReset();
    } catch (err: unknown) {
      const e = err as { message?: string };
      setErrorMsg(e?.message || 'Check-in failed. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <Text style={styles.title}>Dine-in check-in</Text>
            <Text style={styles.subtitle}>
              Enter the customer&apos;s WhatsApp number. We&apos;ll log the visit, award points, and send their reward message automatically.
            </Text>

            {effectiveBranchName ? (
              <View style={styles.branchChip}>
                <Text style={styles.branchChipLabel}>Branch</Text>
                <Text style={styles.branchChipValue} numberOfLines={1}>
                  📍 {effectiveBranchName}
                </Text>
              </View>
            ) : null}

            {multiBranch && (currentBranchId === 'all' || !currentBranchId) ? (
              <Text style={styles.branchHint}>
                Tap the branch chip in the header to switch the recording branch.
              </Text>
            ) : null}

            <Text style={styles.fieldLabel}>Customer phone</Text>
            <TextInput
              value={formatPhoneForDisplay(phoneDigits)}
              onChangeText={(v) => {
                setPhoneDigits(digitsOnly(v));
                if (errorMsg) setErrorMsg(null);
              }}
              keyboardType="number-pad"
              inputMode="numeric"
              placeholder="91 98765 43210"
              placeholderTextColor={colors.mute}
              maxLength={20}
              editable={!submitting}
              style={styles.input}
              autoCorrect={false}
              autoComplete="tel"
            />
            <Text style={styles.fieldHint}>
              {phoneDigits.length < 10
                ? `${10 - phoneDigits.length} more digit${10 - phoneDigits.length === 1 ? '' : 's'} needed`
                : `${phoneDigits.length} digits`}
            </Text>

            <Pressable
              onPress={onSubmit}
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.submitBtn,
                !canSubmit && styles.submitBtnDisabled,
                pressed && canSubmit && { opacity: 0.85 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Record dine-in check-in"
            >
              {submitting ? (
                <ActivityIndicator color={colors.tx} />
              ) : (
                <Text style={styles.submitBtnText}>Check In</Text>
              )}
            </Pressable>

            {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}

            {!effectiveBranchId ? (
              <Text style={styles.errorText}>
                No branch is assigned to this account. Ask the owner to assign you to a branch before recording check-ins.
              </Text>
            ) : null}
          </View>

          {result ? (
            <View style={styles.successCard}>
              <Text style={styles.successTitle}>✅ Check-in recorded</Text>
              {result.customer_name ? (
                <View style={styles.successRow}>
                  <Text style={styles.successLabel}>Customer</Text>
                  <Text style={styles.successValue} numberOfLines={1}>{result.customer_name}</Text>
                </View>
              ) : null}
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>Visit #</Text>
                <Text style={styles.successValue}>{result.visit_number}</Text>
              </View>
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>Points balance</Text>
                <Text style={styles.successValue}>{result.points_balance}</Text>
              </View>
              {result.milestone_hit != null ? (
                <View style={styles.milestoneBadge}>
                  <Text style={styles.milestoneText}>🎉 Milestone {result.milestone_hit} reached</Text>
                </View>
              ) : null}
              <Text style={styles.successHint}>
                Form clears automatically. Tap below to check in another customer now.
              </Text>
              <Pressable
                onPress={resetFormToFresh}
                style={({ pressed }) => [styles.resetBtn, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.resetBtnText}>Check in next customer</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.ink },
  flex: { flex: 1 },
  scroll: { padding: space.px4, gap: space.px4 },
  card: {
    backgroundColor: colors.ink2,
    borderColor: colors.rim,
    borderWidth: 1,
    borderRadius: radius.r,
    padding: space.px5,
    gap: space.px3,
  },
  title: {
    color: colors.tx,
    fontSize: text.xl,
    fontWeight: fontWeight.bold,
    letterSpacing: -0.4,
  },
  subtitle: {
    color: colors.dim,
    fontSize: text.sm,
    lineHeight: 18,
  },
  branchChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.px3,
    paddingHorizontal: space.px3,
    paddingVertical: space.px2,
    backgroundColor: colors.accGlow,
    borderRadius: radius.md,
    alignSelf: 'flex-start',
  },
  branchChipLabel: {
    color: colors.dim,
    fontSize: text.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  branchChipValue: {
    color: colors.acc,
    fontSize: text.sm,
    fontWeight: fontWeight.semibold,
    flexShrink: 1,
  },
  branchHint: {
    color: colors.mute,
    fontSize: text.xs,
  },
  fieldLabel: {
    color: colors.dim,
    fontSize: text.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: space.px2,
  },
  input: {
    backgroundColor: colors.ink,
    borderColor: colors.rim,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.px3,
    paddingVertical: space.px3,
    color: colors.tx,
    fontSize: text.lg,
    letterSpacing: 0.6,
  },
  fieldHint: {
    color: colors.mute,
    fontSize: text.xs,
  },
  submitBtn: {
    backgroundColor: colors.acc,
    borderRadius: radius.md,
    paddingVertical: space.px3,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.px2,
  },
  submitBtnDisabled: {
    backgroundColor: colors.ink3,
  },
  submitBtnText: {
    color: '#FFFFFF',
    fontSize: text.base,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.4,
  },
  errorText: {
    color: colors.red,
    fontSize: text.sm,
    marginTop: space.px1,
  },
  successCard: {
    backgroundColor: colors.ink2,
    borderColor: colors.wa,
    borderWidth: 1,
    borderRadius: radius.r,
    padding: space.px5,
    gap: space.px3,
  },
  successTitle: {
    color: colors.wa,
    fontSize: text.lg,
    fontWeight: fontWeight.bold,
  },
  successRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.px3,
  },
  successLabel: {
    color: colors.dim,
    fontSize: text.sm,
  },
  successValue: {
    color: colors.tx,
    fontSize: text.base,
    fontWeight: fontWeight.semibold,
    flexShrink: 1,
    textAlign: 'right',
  },
  milestoneBadge: {
    backgroundColor: colors.goldGlow,
    borderRadius: radius.md,
    paddingHorizontal: space.px3,
    paddingVertical: space.px2,
    alignSelf: 'flex-start',
  },
  milestoneText: {
    color: colors.gold,
    fontSize: text.sm,
    fontWeight: fontWeight.semibold,
  },
  successHint: {
    color: colors.mute,
    fontSize: text.xs,
  },
  resetBtn: {
    backgroundColor: colors.ink3,
    borderRadius: radius.md,
    paddingVertical: space.px3,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.rim,
  },
  resetBtnText: {
    color: colors.tx,
    fontSize: text.base,
    fontWeight: fontWeight.semibold,
  },
});
