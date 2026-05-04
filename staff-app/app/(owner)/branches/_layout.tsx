// Inner Stack for the Branches tab so the detail screen can override
// the header title and get a back button. The parent Tabs entry sets
// headerShown:false on this tab; this Stack owns the header instead.
//
// LogoutButton mirrors the one in (owner)/_layout.tsx — duplicated rather
// than factored to keep navigator boundaries clean.

import { Stack, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useAuth } from '@/store/authStore';
import { colors } from '@/theme';

function LogoutButton() {
  const router = useRouter();
  const { logout } = useAuth();
  return (
    <Pressable
      onPress={async () => {
        await logout();
        router.replace('/login');
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
        headerTitleStyle: { color: colors.tx, fontWeight: '700' },
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
    marginRight: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.rim,
    borderRadius: 8,
  },
  logoutText: { color: colors.dim, fontSize: 12, fontWeight: '600' },
});
