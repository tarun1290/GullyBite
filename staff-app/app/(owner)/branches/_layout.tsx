// Inner Stack for the Branches tab so the detail screen can override
// the header title and get a back button. The parent Tabs entry sets
// headerShown:false on this tab; this Stack owns the header instead.
//
// LogoutButton mirrors the one in (owner)/_layout.tsx — duplicated rather
// than factored to keep navigator boundaries clean.

import { Stack } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useStaff } from '@/state/StaffContext';
import { colors, fontWeight, radius, space, text } from '@/theme';

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

export default function BranchesStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.ink2 },
        headerTitleStyle: { color: colors.tx, fontWeight: fontWeight.bold },
        headerTintColor: colors.tx,
        headerRight: () => <LogoutButton />,
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Branches' }} />
      <Stack.Screen name="[branchId]" options={{ title: 'Branch' }} />
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
