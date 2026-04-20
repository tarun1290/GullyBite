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

import { Keypad } from '@/components/Keypad';
import { login } from '@/api';
import { saveAuth } from '@/storage';
import { requestPermissionsAndRegister } from '@/push';
import { colors } from '@/theme';

const PIN_LEN = 4;

export default function LoginScreen() {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const shake = useRef(new Animated.Value(0)).current;

  const sanitiseSlug = (s: string) =>
    s.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9-]/g, '');

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
    if (!slug.trim()) {
      setErr('Enter the restaurant slug');
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
      const res = await login(slug, pin);
      await saveAuth(res.token, {
        id: res.restaurant.id,
        name: res.restaurant.name,
        slug: res.restaurant.slug,
        logo_url: res.restaurant.logo_url ?? null,
      });
      // Fire-and-forget push registration — do not block navigation.
      requestPermissionsAndRegister().catch(() => { /* noop */ });
      router.replace('/(tabs)/orders');
    } catch (e) {
      const msg = (e as Error).message || 'Login failed';
      setErr(
        msg.toLowerCase().includes('pin') || msg.toLowerCase().includes('restaurant')
          ? 'Invalid PIN or restaurant'
          : msg
      );
      setPin('');
      doShake();
    } finally {
      setBusy(false);
    }
  };

  // Auto-submit when PIN is 4 digits — nice UX, but we still gate on slug.
  useEffect(() => {
    if (pin.length === PIN_LEN && slug.trim() && !busy) {
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

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
            <Text style={styles.label}>Restaurant slug</Text>
            <TextInput
              value={slug}
              onChangeText={(s) => {
                setErr('');
                setSlug(sanitiseSlug(s));
              }}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="e.g. sharmas-dosa"
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
            disabled={busy || pin.length !== PIN_LEN}
            style={({ pressed }) => [
              styles.loginBtn,
              (busy || pin.length !== PIN_LEN) && styles.loginBtnDisabled,
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
});
