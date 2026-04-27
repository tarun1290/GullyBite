// Per-user, per-branch login. The staff_access_token comes from the
// branch-specific URL the manager sends to the staff member — never
// typed by hand. We pull it from AsyncStorage where _layout.tsx
// stashes it after parsing the deep link, then ask for name + PIN.
//
// If there's no pending token, render an instructional message
// instead of input fields — the staff member has to open the link
// from their manager's WhatsApp/SMS first.

import { useEffect, useRef, useState } from 'react';
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
import { login } from '@/api';
import { useAuth } from '@/store/authStore';
import { requestPermissionsAndRegister } from '@/push';
import { colors } from '@/theme';

const PIN_LEN = 4;
const PENDING_TOKEN_KEY = 'pending_staff_access_token';

export default function LoginScreen() {
  const router = useRouter();
  const { login: storeLogin } = useAuth();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokenChecked, setTokenChecked] = useState(false);
  const shake = useRef(new Animated.Value(0)).current;

  // Hydrate the deep-link token from AsyncStorage on mount. _layout.tsx
  // is the source of truth for parsing incoming URLs and stashing the
  // segment under PENDING_TOKEN_KEY before navigating here.
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

  const submit = async () => {
    if (busy) return;
    if (!accessToken) return;
    if (!name.trim()) {
      setErr('Enter your name');
      doShake();
      return;
    }
    if (pin.length !== PIN_LEN) {
      setErr(`Enter the ${PIN_LEN}-digit PIN`);
      doShake();
      return;
    }
    setBusy(true);
    try {
      const res = await login(accessToken, name.trim(), pin);
      // Persist via the auth store (writes SecureStore + sets state).
      await storeLogin(
        res.token,
        {
          userId: res.staffUser.id,
          name: res.staffUser.name,
          branchId: res.staffUser.branchId,
          permissions: res.staffUser.permissions || {},
        },
        {
          id: res.restaurant.id,
          name: res.restaurant.name,
          slug: res.restaurant.slug,
          logo_url: res.restaurant.logo_url ?? null,
        },
      );
      // Token consumed — clear it so a future logout doesn't auto-login.
      await AsyncStorage.removeItem(PENDING_TOKEN_KEY);
      // Fire-and-forget push registration — do not block navigation.
      requestPermissionsAndRegister().catch(() => { /* noop */ });
      router.replace('/(app)/orders');
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = (e as Error).message || 'Login failed';
      // 401 = wrong name/PIN/token (server returns generic). Anything
      // else is treated as a transient error.
      if (status === 401) setErr('Incorrect name or PIN. Please try again.');
      else setErr(msg.toLowerCase().includes('network') ? 'Connection problem. Please try again.' : 'Something went wrong. Please try again.');
      setPin('');
      doShake();
    } finally {
      setBusy(false);
    }
  };

  // Auto-submit when PIN is 4 digits — gated on name being filled.
  useEffect(() => {
    if (pin.length === PIN_LEN && name.trim() && accessToken && !busy) {
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  // Pre-token-check: brief loader so we don't flash the no-token message.
  if (!tokenChecked) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }} />;
  }

  // No deep-link token — render instructions, no inputs.
  if (!accessToken) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }}>
        <View style={styles.noTokenWrap}>
          <View style={styles.logoBadge}>
            <Text style={styles.logoEmoji}>🔒</Text>
          </View>
          <Text style={styles.brand}>GullyBite Staff</Text>
          <Text style={styles.noTokenText}>
            Please open the staff login link provided by your manager.
          </Text>
          <Text style={styles.noTokenSub}>
            The link looks like https://gullybite.duckdns.org/staff/…
          </Text>
        </View>
      </SafeAreaView>
    );
  }

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
            <Text style={styles.tag}>Sign in to manage orders</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Your name</Text>
            <TextInput
              value={name}
              onChangeText={(s) => {
                setErr('');
                setName(s);
              }}
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
            onPress={submit}
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
  brand: { fontSize: 22, fontWeight: '800', color: colors.tx, letterSpacing: -0.5 },
  tag: { fontSize: 13, color: colors.dim },

  field: { gap: 6 },
  label: { fontSize: 12, fontWeight: '700', color: colors.dim, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: colors.ink2,
    borderWidth: 1, borderColor: colors.rim,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 16, color: colors.tx,
  },

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

  // No-token state
  noTokenWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  noTokenText: { fontSize: 15, color: colors.tx, textAlign: 'center', lineHeight: 22 },
  noTokenSub: { fontSize: 12, color: colors.dim, textAlign: 'center' },
});
