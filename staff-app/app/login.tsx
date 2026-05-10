// Staff login (2026-05-09 refactor). Three inputs:
//   1. store_slug — text, lowercase / hyphen identifier of the
//      restaurant tenant.
//   2. staff_id   — text, the staff member's per-tenant identifier
//      issued by their manager.
//   3. pin        — 4-digit numeric PIN entered via the existing
//      Keypad component (preserves the auto-submit-on-4th-digit UX).
//
// Submission hits POST /api/staff/auth via staffLogin(). On success we
// stash the bearer token in SecureStore (key: gb_staff_token) and tell
// StaffContext to re-hydrate via /me before navigating to the orders
// queue. Errors are mapped to inline messages per the contract:
//   401 → "Invalid credentials"
//   429 → "Too many attempts. Try again in 15 minutes."
//   400 deprecated_login_payload → "App needs an update"
//
// (Part 6b cleanup, 2026-05-10) The legacy deep-link handler that
// stashed gullybite-staff://staff/<token> URLs into AsyncStorage was
// removed from app/_layout.tsx — the current login flow uses
// store_slug + staff_id + pin and the staff_access_token deep-link
// channel is dead.

import { useCallback, useRef, useState } from 'react';
import {
  Animated,
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
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';

import { Keypad } from '@/components/Keypad';
import { staffLogin } from '@/api';
import { useStaff } from '@/state/StaffContext';
import { requestPermissionsAndRegister } from '@/push';
import { colors, space, text, radius, fontWeight } from '@/theme';

const PIN_LEN = 4;
const TOKEN_KEY = 'gb_staff_token';

export default function LoginScreen() {
  const router = useRouter();
  const { refresh: refreshStaff } = useStaff();
  const [storeSlug, setStoreSlug] = useState('');
  const [staffId, setStaffId] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const shake = useRef(new Animated.Value(0)).current;

  const doShake = () => {
    Animated.sequence([
      Animated.timing(shake, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const handleDigit = (d: string) => {
    setErr('');
    setPin((p) => (p.length >= PIN_LEN ? p : p + d));
  };
  const handleBackspace = () => {
    setErr('');
    setPin((p) => p.slice(0, -1));
  };

  // submit accepts an explicit pin so the auto-submit effect below can
  // call it with the freshly-typed digit (state batches haven't flushed
  // by the time onDigit returns).
  const submit = useCallback(async (submittedPin: string) => {
    if (busy) return;
    const slug = storeSlug.trim();
    const sid = staffId.trim();
    if (!slug) {
      setErr('Enter your store slug');
      doShake();
      return;
    }
    if (!sid) {
      setErr('Enter your staff ID');
      doShake();
      return;
    }
    if (submittedPin.length !== PIN_LEN) {
      setErr(`Enter the ${PIN_LEN}-digit PIN`);
      doShake();
      return;
    }
    setBusy(true);
    try {
      const res = await staffLogin({
        store_slug: slug,
        staff_id: sid,
        pin: submittedPin,
      });
      // Persist the bearer token; StaffContext.refresh() will pick it
      // up from SecureStore and hit /api/staff/auth/me to hydrate the
      // sanitized staff record + 10-key permissions.
      await SecureStore.setItemAsync(TOKEN_KEY, res.token);
      await refreshStaff();
      // Best-effort push registration. Non-blocking — fire-and-forget.
      requestPermissionsAndRegister().catch(() => { /* noop */ });
      router.replace('/(app)/orders');
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = (e as Error).message || '';
      if (status === 401) {
        setErr('Invalid credentials');
      } else if (status === 429) {
        setErr('Too many attempts. Try again in 15 minutes.');
      } else if (status === 400 && /deprecated_login_payload/i.test(msg)) {
        // Defensive — shouldn't fire with the new payload shape, but
        // if a stale build reaches the new backend the contract has
        // this branch carved out so we surface it clearly rather than
        // a generic "Login failed".
        setErr('App needs an update');
      } else if (msg.toLowerCase().includes('network')) {
        setErr('Check your connection.');
      } else {
        setErr('Something went wrong. Please try again.');
      }
      setPin('');
      doShake();
    } finally {
      setBusy(false);
    }
    // doShake / shake are stable (ref); router and refreshStaff are
    // hook returns. setStoreSlug / setStaffId are stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeSlug, staffId, busy, router]);

  // Auto-submit on the 4th digit. Gated on both text inputs being
  // populated so a partial form doesn't fire a guaranteed-400.
  const onDigit = (d: string) => {
    setErr('');
    setPin((p) => {
      if (p.length >= PIN_LEN) return p;
      const next = p + d;
      if (
        next.length === PIN_LEN &&
        storeSlug.trim() &&
        staffId.trim() &&
        !busy
      ) {
        // Defer to next tick so React commits the state update before
        // submit reads from refs / closures.
        setTimeout(() => { void submit(next); }, 0);
      }
      return next;
    });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.logoWrap}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoEmoji}>🍕</Text>
            </View>
            <Text style={styles.brand}>GullyBite Staff</Text>
            <Text style={styles.tag}>Sign in with your store, staff ID, and PIN.</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Store</Text>
            <TextInput
              value={storeSlug}
              onChangeText={(s) => { setErr(''); setStoreSlug(s); }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="default"
              placeholder="e.g. tasty-bites"
              placeholderTextColor={colors.mute}
              style={styles.input}
              returnKeyType="next"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Staff ID</Text>
            <TextInput
              value={staffId}
              onChangeText={(s) => { setErr(''); setStaffId(s); }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="default"
              placeholder="Your staff ID"
              placeholderTextColor={colors.mute}
              style={styles.input}
              returnKeyType="done"
            />
          </View>

          <Animated.View style={[styles.pinRow, { transform: [{ translateX: shake }] }]}>
            {Array.from({ length: PIN_LEN }).map((_, i) => (
              <View
                key={i}
                style={[styles.pinDot, i < pin.length && styles.pinDotFilled]}
              />
            ))}
          </Animated.View>

          {err ? <Text style={styles.err}>{err}</Text> : <View style={styles.errPlaceholder} />}

          <Keypad onDigit={onDigit} onBackspace={handleBackspace} disabled={busy} />

          <View style={{ height: 16 }} />
          <Pressable
            onPress={() => void submit(pin)}
            disabled={busy || !storeSlug.trim() || !staffId.trim() || pin.length !== PIN_LEN}
            style={({ pressed }) => [
              styles.loginBtn,
              (busy || !storeSlug.trim() || !staffId.trim() || pin.length !== PIN_LEN) && styles.loginBtnDisabled,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={styles.loginBtnText}>
              {busy ? 'Signing in…' : 'Log in'}
            </Text>
          </Pressable>

          <Pressable onPress={() => router.push('/owner-login')} style={styles.altLink}>
            <Text style={styles.altLinkText}>Restaurant owner? Sign in here</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.px6, paddingBottom: space.px10, gap: space.px4 },
  logoWrap: { alignItems: 'center', marginTop: space.px2, marginBottom: space.px3, gap: space.px2 },
  logoBadge: {
    width: 72, height: 72, borderRadius: radius['3xl'],
    backgroundColor: colors.acc,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.acc, shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  logoEmoji: { fontSize: 36 }, // off-scale font: 36
  brand: { fontSize: text.xl, fontWeight: fontWeight.extrabold, color: colors.tx, letterSpacing: -0.5, textAlign: 'center' },
  tag: { fontSize: text.sm, color: colors.dim, textAlign: 'center' },

  field: { gap: space.px2 },
  label: { fontSize: text.xs, fontWeight: fontWeight.bold, color: colors.dim, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: colors.ink2,
    borderWidth: 1, borderColor: colors.rim,
    borderRadius: radius.lg, paddingHorizontal: space.px4, paddingVertical: space.px3,
    fontSize: text.lg, color: colors.tx,
  },

  pinRow: { flexDirection: 'row', gap: space.px4, justifyContent: 'center', marginVertical: space.px3 },
  pinDot: {
    width: 18, height: 18, borderRadius: radius.md,
    borderWidth: 2, borderColor: colors.rim2, backgroundColor: 'transparent',
  },
  pinDotFilled: { backgroundColor: colors.acc, borderColor: colors.acc },

  err: { color: colors.red, fontSize: text.sm, textAlign: 'center', minHeight: 18 },
  errPlaceholder: { minHeight: 18 },

  loginBtn: {
    backgroundColor: colors.acc, paddingVertical: space.px4,
    borderRadius: radius.xl, alignItems: 'center',
    shadowColor: colors.acc, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  loginBtnDisabled: { backgroundColor: colors.rim2, shadowOpacity: 0, elevation: 0 },
  loginBtnText: { color: colors.ink2, fontSize: text.lg, fontWeight: fontWeight.bold },

  altLink: { alignItems: 'center', paddingVertical: space.px3 },
  altLinkText: { color: colors.dim, fontSize: text.xs },
});
