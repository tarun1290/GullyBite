// Owner settings: profile summary + escape hatch to the full web dashboard.
// Intentionally thin in v1 — most owner controls (WABA, billing, advanced
// menu management) live on gullybite.duckdns.org and don't make sense to
// rebuild as native screens. Logout button is the only state change here.

import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';

import { useAuth } from '@/store/authStore';
import { colors } from '@/theme';

const FULL_DASHBOARD_URL = 'https://gullybite.duckdns.org';

export default function OwnerSettingsScreen() {
  const router = useRouter();
  const { restaurant, ownerInfo, logout } = useAuth();
  const version = Constants.expoConfig?.version || '—';

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.profileCard}>
        <View style={styles.logoWrap}>
          {restaurant?.logo_url ? (
            <Image source={{ uri: restaurant.logo_url }} style={styles.logoImg} />
          ) : (
            <View style={styles.logoFallback}>
              <Text style={styles.logoEmoji}>🍽️</Text>
            </View>
          )}
        </View>
        <Text style={styles.restaurantName} numberOfLines={2}>
          {restaurant?.name || ownerInfo?.name || 'Restaurant'}
        </Text>
        {ownerInfo?.name ? <Text style={styles.ownerName}>{ownerInfo.name}</Text> : null}
        <Text style={styles.versionText}>App version {version}</Text>
      </View>

      <Pressable
        onPress={async () => {
          await logout();
          router.replace('/login');
        }}
        style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.85 }]}
      >
        <Text style={styles.logoutBtnText}>Log out</Text>
      </Pressable>

      <Pressable
        onPress={() => { void Linking.openURL(FULL_DASHBOARD_URL); }}
        style={({ pressed }) => [styles.linkWrap, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.linkText}>
          For menu management, WABA, and advanced settings visit the dashboard at gullybite.duckdns.org
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 16, paddingBottom: 40 },

  profileCard: {
    backgroundColor: colors.ink2,
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.rim,
    alignItems: 'center',
    gap: 8,
  },
  logoWrap: { marginBottom: 4 },
  logoImg: { width: 84, height: 84, borderRadius: 42, backgroundColor: colors.ink },
  logoFallback: {
    width: 84, height: 84, borderRadius: 42,
    backgroundColor: colors.ink,
    borderWidth: 1, borderColor: colors.rim,
    alignItems: 'center', justifyContent: 'center',
  },
  logoEmoji: { fontSize: 38 },
  restaurantName: { fontSize: 18, fontWeight: '800', color: colors.tx, textAlign: 'center' },
  ownerName: { fontSize: 13, color: colors.dim },
  versionText: { fontSize: 11, color: colors.mute, marginTop: 6 },

  logoutBtn: {
    backgroundColor: colors.red,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  logoutBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  linkWrap: { paddingHorizontal: 8, paddingVertical: 12 },
  linkText: { fontSize: 12, color: colors.dim, textAlign: 'center', lineHeight: 18 },
});
