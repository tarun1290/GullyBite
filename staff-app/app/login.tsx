// Per-user, per-branch login. Two entry paths to capture the
// staff_access_token before PIN entry:
//
//   1. Deep link / app/_layout.tsx parses an inbound
//      gullybite-staff://staff/{token} URL and stashes the segment
//      under PENDING_TOKEN_KEY in AsyncStorage. We hydrate from there
//      on mount.
//   2. Paste link — operator pastes the staff_login_url their manager
//      shared. We extract the {token} segment from the URL path via
//      extractTokenFromUrl below.
//
// Once a token is captured (either path), we hit GET /staff/branch-info
// to resolve "{restaurant_name} — {branch_name}" and show that as the
// header for the PIN form. A 404 from the lookup means the link is bad
// — we surface a "this link is invalid" message and let the operator
// paste a different one. Other failures fall through to the form so a
// transient network blip doesn't lock out a working token.

import { useCallback, useEffect, useRef, useState } from 'react';
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
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Keypad } from '@/components/Keypad';
import { login, getBranchInfo, type BranchInfo } from '@/api';
import { useAuth } from '@/store/authStore';
import { requestPermissionsAndRegister } from '@/push';
import { colors } from '@/theme';

const PIN_LEN = 4;
const PENDING_TOKEN_KEY = 'pending_staff_access_token';

// Pulls the token segment out of a pasted URL. Accepts:
//   https://gullybite.duckdns.org/staff/<token>
//   https://gullybite.duckdns.org/staff/<token>/orders
//   gullybite-staff://staff/<token>
// Plus the bare token form (operator pastes just the UUID). Returns
// null if nothing token-shaped is found. Token shape gate is loose
// (>= 16 chars, hex/alphanum/dash) — the backend's branch-info call
// is the actual validator.
function extractTokenFromUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Bare token — accept as-is.
  if (/^[a-zA-Z0-9_-]{16,100}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/\/staff\/([a-zA-Z0-9_-]{16,100})(?:\/|$|\?|#)/);
  return match ? match[1] : null;
}

type BranchInfoState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: BranchInfo }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string };

export default function LoginScreen() {
  const router = useRouter();
  const { login: storeLogin } = useAuth();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [tokenChecked, setTokenChecked] = useState(false);
  const [pasteInput, setPasteInput] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [branchInfo, setBranchInfo] = useState<BranchInfoState>({ kind: 'idle' });
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const shake = useRef(new Animated.Value(0)).current;

  // Hydrate the deep-link token from AsyncStorage on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t = await AsyncStorage.getItem(PENDING_TOKEN_KEY);
      if (!cancelled) {
        setAccessToken(t);
        setTokenChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Once a token is captured (deep-link or paste), resolve branch info
  // for the confirmation surface. 404 → 'invalid' so we show a clear
  // "this link is bad" surface and let the operator try another. Other
  // failures fall through to 'error' but we still let them try the PIN
  // — a working POST /auth means the token is valid even if the
  // companion GET hiccupped.
  useEffect(() => {
    if (!accessToken) {
      setBranchInfo({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setBranchInfo({ kind: 'loading' });
    getBranchInfo(accessToken)
      .then((data) => {
        if (cancelled) return;
        setBranchInfo({ kind: 'ready', data });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const status = (e as { status?: number }).status;
        if (status === 404) {
          setBranchInfo({ kind: 'invalid' });
          return;
        }
        const msg = (e as Error).message || '';
        setBranchInfo({
          kind: 'error',
          message: msg.toLowerCase().includes('network') ? 'Check your connection.' : 'Could not load branch info',
        });
      });
    return () => { cancelled = true; };
  }, [accessToken]);

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

  // Submit accepts an explicit pin so auto-submit can call it with the
  // freshly-typed value (state batches haven't flushed inside onDigit).
  const submit = useCallback(async (submittedPin: string) => {
    if (busy) return;
    if (!accessToken) return;
    if (!name.trim()) {
      setErr('Enter your name');
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
      const res = await login(accessToken, name.trim(), submittedPin);
      // Persist via the auth store. saveAuth() under the hood writes
      // gb_staff_token + gb_staff_restaurant + gb_staff_info to
      // SecureStore. branchId + restaurantId are persisted as part of
      // those blobs (read via getStaffInfo().branchId and
      // getRestaurant().id) — no separate top-level keys, single
      // source of truth for each value.
      await storeLogin(
        res.token,
        {
          userId: res.staffUser.id,
          name: res.staffUser.name,
          branchId: res.staffUser.branchId,
          // Pass through the role from the auth response so manager
          // sessions register as 'manager' (not the hardcoded 'staff'
          // pre-fix). 'staff' fallback covers a legacy backend without
          // the role field.
          role: res.staffUser.role || 'staff',
          // Multi-branch fields — fall back to a single-element list
          // built from branchId for legacy backends that haven't shipped
          // the arrays yet, so the selector still renders correctly.
          branchIds: res.staffUser.branch_ids
            && res.staffUser.branch_ids.length > 0
            ? res.staffUser.branch_ids
            : [res.staffUser.branchId],
          branches: res.staffUser.branches || [
            { id: res.staffUser.branchId, name: res.restaurant.name || 'Branch' },
          ],
          permissions: res.staffUser.permissions || {},
        },
        {
          id: res.restaurant.id,
          name: res.restaurant.name,
          slug: res.restaurant.slug,
          logo_url: res.restaurant.logo_url ?? null,
        },
      );
      // Token consumed — clear so a future logout doesn't auto-relogin.
      await AsyncStorage.removeItem(PENDING_TOKEN_KEY);
      requestPermissionsAndRegister().catch(() => { /* noop */ });
      router.replace('/(app)/orders');
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = (e as Error).message || 'Login failed';
      if (status === 401) {
        setErr('Invalid name or PIN');
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
    // doShake / shake are stable (ref); router and storeLogin from
    // hooks. Auth-store login signature is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, name, busy, router]);

  // Auto-submit on 4th digit. Gated on name + non-busy + token + a
  // valid (ready) branch info so we never auto-submit against a known-
  // invalid link.
  useEffect(() => {
    if (
      pin.length === PIN_LEN &&
      name.trim() &&
      accessToken &&
      !busy &&
      branchInfo.kind !== 'invalid'
    ) {
      void submit(pin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const onPasteSubmit = () => {
    setPasteError(null);
    const token = extractTokenFromUrl(pasteInput);
    if (!token) {
      setPasteError("That doesn't look like a staff login link.");
      return;
    }
    setAccessToken(token);
    setPasteInput('');
    // Persist so a refresh / app relaunch keeps the captured token.
    void AsyncStorage.setItem(PENDING_TOKEN_KEY, token);
  };

  const resetEntry = () => {
    setAccessToken(null);
    setBranchInfo({ kind: 'idle' });
    setPin('');
    setName('');
    setErr('');
    void AsyncStorage.removeItem(PENDING_TOKEN_KEY);
  };

  // Pre-token-check: brief loader so we don't flash the no-token UI.
  if (!tokenChecked) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }} />;
  }

  // ── Entry surface (no token yet) ──────────────────────────────────
  if (!accessToken) {
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
                <Text style={styles.logoEmoji}>🔒</Text>
              </View>
              <Text style={styles.brand}>GullyBite Staff</Text>
              <Text style={styles.tag}>Link this device to a branch to begin.</Text>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Paste your branch login link</Text>
              <TextInput
                value={pasteInput}
                onChangeText={(s) => { setPasteError(null); setPasteInput(s); }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://gullybite.duckdns.org/staff/…"
                placeholderTextColor={colors.mute}
                style={styles.input}
                returnKeyType="go"
                onSubmitEditing={onPasteSubmit}
              />
              {pasteError ? <Text style={styles.err}>{pasteError}</Text> : null}
              <Pressable
                onPress={onPasteSubmit}
                disabled={!pasteInput.trim()}
                style={({ pressed }) => [
                  styles.loginBtn,
                  !pasteInput.trim() && styles.loginBtnDisabled,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text style={styles.loginBtnText}>Continue</Text>
              </Pressable>
              <Text style={styles.hint}>
                Your manager shared this link in WhatsApp. Open it once or copy and paste here.
              </Text>
            </View>

            <Pressable onPress={() => router.push('/owner-login')} style={styles.altLink}>
              <Text style={styles.altLinkText}>Restaurant owner? Sign in here</Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── Branch-info loading ──
  if (branchInfo.kind === 'loading') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }}>
        <View style={styles.noTokenWrap}>
          <Text style={styles.noTokenSub}>Checking link…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Invalid link from /branch-info 404 ──
  if (branchInfo.kind === 'invalid') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }}>
        <View style={styles.noTokenWrap}>
          <View style={styles.logoBadge}>
            <Text style={styles.logoEmoji}>⚠️</Text>
          </View>
          <Text style={styles.brand}>This link is invalid or expired</Text>
          <Text style={styles.noTokenSub}>
            Ask your manager to share a fresh staff login link.
          </Text>
          <Pressable onPress={resetEntry} style={[styles.loginBtn, { marginTop: 16, alignSelf: 'stretch' }]}>
            <Text style={styles.loginBtnText}>Try a different link</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ── Token captured + (ready or transient error) — show form ──
  const heading = branchInfo.kind === 'ready'
    ? [branchInfo.data.restaurant_name, branchInfo.data.branch_name].filter(Boolean).join(' — ')
    : null;

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
            <Text style={styles.brand}>{heading || 'GullyBite Staff'}</Text>
            <Text style={styles.tag}>Sign in with your name and 4-digit PIN</Text>
            {branchInfo.kind === 'error' && (
              <Text style={[styles.tag, { color: colors.red }]}>{branchInfo.message}</Text>
            )}
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Your name</Text>
            <TextInput
              value={name}
              onChangeText={(s) => { setErr(''); setName(s); }}
              autoCapitalize="words"
              autoCorrect={false}
              placeholder="Your name as registered"
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

          <Keypad onDigit={handleDigit} onBackspace={handleBackspace} disabled={busy} />

          <View style={{ height: 16 }} />
          <Pressable
            onPress={() => void submit(pin)}
            disabled={busy || !name.trim() || pin.length !== PIN_LEN}
            style={({ pressed }) => [
              styles.loginBtn,
              (busy || !name.trim() || pin.length !== PIN_LEN) && styles.loginBtnDisabled,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={styles.loginBtnText}>
              {busy ? 'Signing in…' : 'Log in'}
            </Text>
          </Pressable>

          <Pressable onPress={resetEntry} style={styles.altLink}>
            <Text style={styles.altLinkText}>Use a different link</Text>
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
  scroll: { padding: 24, paddingBottom: 40, gap: 16 },
  logoWrap: { alignItems: 'center', marginTop: 8, marginBottom: 12, gap: 8 },
  logoBadge: {
    width: 72, height: 72, borderRadius: 20,
    backgroundColor: colors.acc,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.acc, shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  logoEmoji: { fontSize: 36 },
  brand: { fontSize: 20, fontWeight: '800', color: colors.tx, letterSpacing: -0.5, textAlign: 'center' },
  tag: { fontSize: 13, color: colors.dim, textAlign: 'center' },

  field: { gap: 8 },
  label: { fontSize: 12, fontWeight: '700', color: colors.dim, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: colors.ink2,
    borderWidth: 1, borderColor: colors.rim,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 16, color: colors.tx,
  },
  hint: { fontSize: 12, color: colors.dim, lineHeight: 18 },

  pinRow: { flexDirection: 'row', gap: 14, justifyContent: 'center', marginVertical: 12 },
  pinDot: {
    width: 18, height: 18, borderRadius: 9,
    borderWidth: 2, borderColor: colors.rim2, backgroundColor: 'transparent',
  },
  pinDotFilled: { backgroundColor: colors.acc, borderColor: colors.acc },

  err: { color: colors.red, fontSize: 13, textAlign: 'center', minHeight: 18 },
  errPlaceholder: { minHeight: 18 },

  loginBtn: {
    backgroundColor: colors.acc, paddingVertical: 14,
    borderRadius: 12, alignItems: 'center',
    shadowColor: colors.acc, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  loginBtnDisabled: { backgroundColor: colors.rim2, shadowOpacity: 0, elevation: 0 },
  loginBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  noTokenWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  noTokenSub: { fontSize: 13, color: colors.dim, textAlign: 'center' },

  altLink: { alignItems: 'center', paddingVertical: 12 },
  altLinkText: { color: colors.dim, fontSize: 12 },
});
