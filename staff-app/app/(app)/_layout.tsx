import { Tabs } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
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
      <Tabs.Screen
        name="menu/index"
        options={{
          title: 'Menu',
          tabBarLabel: 'Menu',
          tabBarIcon: ({ color, size }) => <Ionicons name="restaurant-outline" color={color} size={size} />,
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
