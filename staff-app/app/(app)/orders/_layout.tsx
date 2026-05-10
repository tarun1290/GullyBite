// Inner Stack for the Orders tab so the [orderId] detail screen can
// override the header title and get a back button. The parent Tabs entry
// sets headerShown:false on this tab; this Stack owns the header instead.
//
// Mirrors (owner)/branches/_layout.tsx — duplicated rather than factored
// to keep navigator boundaries clean.

import { Stack } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import BranchSelector from '@/components/BranchSelector';
import { useStaff } from '@/state/StaffContext';
import { colors, space, text, radius, fontWeight } from '@/theme';

function LogoutButton() {
  const { logout } = useStaff();
  return (
    <Pressable
      // Part 6d Track B6 — the redundant `router.replace('/login')`
      // post-await is gone. StaffContext.logout() handles the redirect.
      onPress={async () => {
        await logout();
      }}
      style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.7 }]}
      accessibilityLabel="Log out"
    >
      <Text style={styles.logoutText}>Log out</Text>
    </Pressable>
  );
}

export default function OrdersStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.ink2 },
        headerTitleStyle: { color: colors.tx, fontWeight: fontWeight.bold },
        headerTintColor: colors.tx,
        headerLeft: () => <BranchSelector />,
        headerRight: () => <LogoutButton />,
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Orders' }} />
      <Stack.Screen name="[orderId]" options={{ title: 'Order' }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  logoutBtn: {
    marginRight: space.px3,
    paddingHorizontal: space.px3,
    paddingVertical: space.px2,
    borderWidth: 1,
    borderColor: colors.rim,
    borderRadius: radius.md,
  },
  logoutText: { color: colors.dim, fontSize: text.xs, fontWeight: fontWeight.semibold }, // was 12, rounded to 11.5 (xs)
});
