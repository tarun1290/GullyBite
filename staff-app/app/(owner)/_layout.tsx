// Owner-app tab layout. Three tabs — Dashboard, Branches, Settings.
// Mirrors (app)/_layout.tsx (same colors, same headerStyle, same
// LogoutButton pattern) so staff and owner experiences feel like one app.
//
// The Branches tab nests a Stack (branches/_layout.tsx) so the detail
// screen [branchId].tsx gets its own header title + back button without
// fighting the tab's header. headerShown:false on the branches tab keeps
// the inner Stack's header from doubling up with the tab header.

import { Tabs } from 'expo-router';
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

export default function OwnerTabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.acc,
        tabBarInactiveTintColor: colors.dim,
        tabBarStyle: { borderTopColor: colors.rim, backgroundColor: colors.ink2 },
        headerStyle: { backgroundColor: colors.ink2, borderBottomColor: colors.rim },
        headerTitleStyle: { color: colors.tx, fontWeight: fontWeight.bold },
        headerRight: () => <LogoutButton />,
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>📊</Text>,
        }}
      />
      <Tabs.Screen
        name="branches"
        options={{
          title: 'Branches',
          headerShown: false, // inner Stack owns the header for this tab
          tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>🏪</Text>,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>⚙️</Text>,
        }}
      />
    </Tabs>
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
