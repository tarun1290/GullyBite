// Owner sign-in (email + password). Distinct from staff login.tsx —
// staff path uses a deep-link access token + 4-digit PIN; this path is
// for the restaurant owner using the same APK. Posts to
// /api/restaurant/owner/login and stores the resulting JWT under role
// 'owner' so the route guard in _layout.tsx routes us to /(owner)/dashboard.

import { useState } from 'react';
import {
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

import { ownerLogin } from '@/api';
import { requestOwnerPermissionsAndRegister } from '@/push';
import { useStaff } from '@/state/StaffContext';
import { colors, space, text, radius, fontWeight } from '@/theme';

export default function OwnerLoginScreen() {
  const router = useRouter();
  const { loginAsOwner } = useStaff();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (busy) return;
    if (!email.trim() || !password) {
      setErr('Enter your email and password');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const res = await ownerLogin(email.trim(), password);
      await loginAsOwner(
        res.token,
        {
          id: res.restaurant.id,
          name: res.restaurant.name,
          slug: res.restaurant.slug,
          logo_url: res.restaurant.logo_url ?? null,
        },
        {
          restaurantId: res.restaurant.id,
          name: res.restaurant.name || '',
        },
      );
      // Fire-and-forget push registration — same pattern as the staff
      // login. Permission prompt + Expo token fetch can take several
      // seconds and must not block the navigate to the dashboard.
      requestOwnerPermissionsAndRegister().catch(() => { /* noop */ });
      router.replace('/(owner)/dashboard');
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = (e as Error).message || 'Login failed';
      // Server returns 401 / "Invalid credentials" for both unknown email
      // and bad password — don't help an attacker distinguish.
      if (status === 401) setErr('Incorrect email or password.');
      else if (status === 400) setErr(msg);
      else setErr(msg.toLowerCase().includes('network') ? 'Connection problem. Please try again.' : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || !email.trim() || !password;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.logoWrap}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoEmoji}>🍕</Text>
            </View>
            <Text style={styles.brand}>GullyBite Owner</Text>
            <Text style={styles.tag}>Sign in to your restaurant dashboard</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              value={email}
              onChangeText={(s) => { setErr(''); setEmail(s); }}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              placeholder="you@restaurant.com"
              placeholderTextColor={colors.mute}
              style={styles.input}
              returnKeyType="next"
              editable={!busy}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              value={password}
              onChangeText={(s) => { setErr(''); setPassword(s); }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="password"
              placeholder="Your password"
              placeholderTextColor={colors.mute}
              style={styles.input}
              returnKeyType="done"
              onSubmitEditing={submit}
              editable={!busy}
            />
          </View>

          {err ? <Text style={styles.err}>{err}</Text> : <View style={styles.errPlaceholder} />}

          <Pressable
            onPress={submit}
            disabled={disabled}
            style={({ pressed }) => [
              styles.loginBtn,
              disabled && styles.loginBtnDisabled,
              pressed && !disabled && { opacity: 0.85 },
            ]}
          >
            <Text style={styles.loginBtnText}>{busy ? 'Signing in…' : 'Log in'}</Text>
          </Pressable>

          <Pressable onPress={() => router.replace('/login')} style={styles.altLink}>
            <Text style={styles.altLinkText}>Staff member? Sign in here</Text>
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
  brand: { fontSize: text.xl, fontWeight: fontWeight.extrabold, color: colors.tx, letterSpacing: -0.5 }, // was 22, rounded to 20 (xl)
  tag: { fontSize: text.sm, color: colors.dim },

  field: { gap: space.px2 }, // was 6, rounded to 8 (px2)
  label: { fontSize: text.xs, fontWeight: fontWeight.bold, color: colors.dim, textTransform: 'uppercase', letterSpacing: 0.5 }, // was 12, rounded to 11.5 (xs)
  input: {
    backgroundColor: colors.ink2,
    borderWidth: 1, borderColor: colors.rim,
    borderRadius: radius.lg, paddingHorizontal: space.px4, paddingVertical: space.px3, // was 14, rounded to 16 (px4)
    fontSize: text.lg, color: colors.tx, // was 16, rounded to 17 (lg)
  },

  err: { color: colors.red, fontSize: text.sm, textAlign: 'center', minHeight: 18 },
  errPlaceholder: { minHeight: 18 },

  loginBtn: {
    backgroundColor: colors.acc, paddingVertical: space.px4, // was 14, rounded to 16 (px4)
    borderRadius: radius.xl, alignItems: 'center',
    shadowColor: colors.acc, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  loginBtnDisabled: { backgroundColor: colors.rim2, shadowOpacity: 0, elevation: 0 },
  loginBtnText: { color: colors.ink2, fontSize: text.lg, fontWeight: fontWeight.bold }, // was 16, rounded to 17 (lg)

  altLink: { alignItems: 'center', paddingVertical: space.px3 },
  altLinkText: { color: colors.dim, fontSize: text.xs }, // was 12, rounded to 11.5 (xs)
});
