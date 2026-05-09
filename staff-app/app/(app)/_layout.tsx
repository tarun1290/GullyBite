import { Tabs } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/store/authStore';
import BranchSelector from '@/components/BranchSelector';
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

// Brand teal — pinned literal here (rather than colors.acc which is
// the indigo-toned accent) to match the dashboard's primary action
// color across both surfaces.
const TAB_ACTIVE_TINT = '#0F766E';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: TAB_ACTIVE_TINT,
        tabBarInactiveTintColor: colors.dim,
        tabBarStyle: { borderTopColor: colors.rim, backgroundColor: colors.ink2 },
        headerStyle: { backgroundColor: colors.ink2, borderBottomColor: colors.rim },
        headerTitleStyle: { color: colors.tx, fontWeight: '700' },
        // Branch selector lives in headerLeft on every screen in this
        // group. It hides itself when the operator is assigned a single
        // branch (BranchSelector returns null), so single-branch sessions
        // see the original layout unchanged.
        headerLeft: () => <BranchSelector />,
        headerRight: () => <LogoutButton />,
      }}
    >
      {/* Orders folder = orders/index.tsx (list) + orders/[orderId].tsx
          (detail). Without an inner _layout.tsx, expo-router auto-
          discovers each .tsx as a sibling tab unless we explicitly
          declare them. The detail screen gets href: null so it doesn't
          show in the tab bar — it's reachable only via push from the
          list screen or a deep link. */}
      <Tabs.Screen
        name="orders/index"
        options={{
          title: 'Orders',
          tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>📦</Text>,
        }}
      />
      <Tabs.Screen
        name="orders/[orderId]"
        options={{ href: null }}
      />
      <Tabs.Screen
        name="menu/index"
        options={{
          title: 'Menu',
          tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>🍽️</Text>,
        }}
      />
    </Tabs>
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
