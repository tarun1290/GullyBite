// NoAccessScreen — fallback for screens a user navigates to without
// permission. Lock icon + configurable message + button back to the
// orders list (the only universally-permitted staff screen).
//
// Used as the fallback prop on screen-level <RequirePermission> wrappers
// (e.g. the menu/index screen for staff without manage_menu OR
// manage_stock) and for the root-level access gate when a staff
// session has no operational permissions at all.
//
// Owner / manager sessions never render this — RequirePermission's
// bypass triggers before the fallback is reached.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { colors, fontWeight, radius, space, text } from '@/theme';

type Props = {
  // Optional override message. Defaults to a generic "no access" line.
  message?: string;
};

const DEFAULT_MESSAGE =
  'You don’t have permission to view this screen. Ask your manager to update your role.';

export default function NoAccessScreen({ message }: Props): React.ReactElement {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.wrap}>
        <View style={styles.card}>
          <Text style={styles.lock}>{'\u{1F512}'}</Text>
          <Text style={styles.title}>No access</Text>
          <Text style={styles.body}>{message || DEFAULT_MESSAGE}</Text>
          <Pressable
            onPress={() => router.replace('/(app)/orders')}
            style={({ pressed }) => [styles.btn, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.btnText}>Back to Orders</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.ink },
  wrap: { flex: 1, padding: space.px4, justifyContent: 'flex-start' },
  card: {
    backgroundColor: colors.ink2,
    borderWidth: 1,
    borderColor: colors.rim,
    borderRadius: radius.xl,
    padding: space.px4,
    gap: space.px3,
    alignItems: 'center',
  },
  lock: { fontSize: 36 },
  title: { fontSize: text.lg, fontWeight: fontWeight.extrabold, color: colors.tx },
  body: { fontSize: text.sm, color: colors.dim, lineHeight: 20, textAlign: 'center' },
  btn: {
    backgroundColor: colors.acc,
    paddingHorizontal: space.px4,
    paddingVertical: space.px3,
    borderRadius: radius.lg,
    marginTop: space.px2,
  },
  btnText: { color: '#fff', fontSize: text.base, fontWeight: fontWeight.bold },
});
