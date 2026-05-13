import { Tabs } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStaff, useStaffPermissions } from '@/state/StaffContext';
import BranchSelector from '@/components/BranchSelector';
import { colors, space, text, radius, fontWeight } from '@/theme';

function LogoutButton() {
  const { logout } = useStaff();
  return (
    <Pressable
      // Part 6d Track B6 — the redundant `router.replace('/login')`
      // post-await is gone. StaffContext.logout() (Part 6c) already
      // handles the navigation internally.
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

// Brand teal — sourced from theme.colors.acc (which now resolves to
// '#0F766E' after the Part 5 brand-flip; the Part 2 design-tokens
// package is the canonical source).
const TAB_ACTIVE_TINT = colors.acc;

export default function TabsLayout() {
  // Part 6d Track B2 — Menu tab visibility is gated on
  // (canManageMenu || canManageStock). When both are false, the tab
  // disappears from the bar entirely. Owner / manager sessions bypass
  // naturally because the backend stamps every flag true on those
  // roles. Plain staff with neither permission never see the tab AND
  // can't navigate to it.
  const { role } = useStaff();
  const { canManageMenu, canManageStock } = useStaffPermissions();
  const showMenuTab =
    role === 'owner' || role === 'manager' || canManageMenu || canManageStock;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: TAB_ACTIVE_TINT,
        tabBarInactiveTintColor: colors.dim,
        tabBarStyle: { borderTopColor: colors.rim, backgroundColor: colors.ink2 },
        headerStyle: { backgroundColor: colors.ink2, borderBottomColor: colors.rim },
        headerTitleStyle: { color: colors.tx, fontWeight: fontWeight.bold },
        // Branch selector lives in headerLeft on every screen in this
        // group. It hides itself when the operator is assigned a single
        // branch (BranchSelector returns null), so single-branch sessions
        // see the original layout unchanged.
        headerLeft: () => <BranchSelector />,
        headerRight: () => <LogoutButton />,
      }}
    >
      {/* Orders folder owns its own Stack (orders/_layout.tsx) so the
          [orderId] detail screen doesn't surface as a sibling tab and
          gets its own header title + back button. headerShown:false
          here lets the inner Stack render the header without doubling
          up. */}
      <Tabs.Screen
        name="orders"
        options={{
          title: 'Orders',
          tabBarLabel: 'Orders',
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="receipt-outline" color={color} size={size} />,
        }}
      />
      {showMenuTab ? (
        <Tabs.Screen
          name="menu/index"
          options={{
            title: 'Menu',
            tabBarLabel: 'Menu',
            tabBarIcon: ({ color, size }) => <Ionicons name="restaurant-outline" color={color} size={size} />,
          }}
        />
      ) : null}
      {/* Dine-in QR check-in surface. Always visible to authed staff —
          the backend route allows any staff JWT (no permission gate
          since the action is read-only on the customer side: log a
          visit + award points configured on the branch). The BranchSelector
          in headerLeft handles multi-branch sessions; single-branch
          sessions see no chrome change. */}
      <Tabs.Screen
        name="dine-in"
        options={{
          title: 'Dine-in',
          tabBarLabel: 'Dine-in',
          tabBarIcon: ({ color, size }) => <Ionicons name="fast-food-outline" color={color} size={size} />,
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
