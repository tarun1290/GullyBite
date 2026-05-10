// Owner settings: profile summary + escape hatch to the full web dashboard.
// Intentionally thin in v1 — most owner controls (WABA, billing, advanced
// menu management) live on gullybite.duckdns.org and don't make sense to
// rebuild as native screens. Logout button is the only state change here.

import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';

import { useStaff } from '@/state/StaffContext';
import { colors, fontWeight, radius, space, text } from '@/theme';

const FULL_DASHBOARD_URL = 'https://gullybite.duckdns.org';

export default function OwnerSettingsScreen() {
  const { restaurant, ownerInfo, logout } = useStaff();
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
        // Part 6d Track B6 — the redundant `router.replace('/login')`
        // post-await is gone. StaffContext.logout() handles the redirect.
        onPress={async () => {
          await logout();
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
  scroll: { padding: space.px4, gap: space.px4, paddingBottom: space.px10 },

  profileCard: {
    backgroundColor: colors.ink2,
    borderRadius: radius['2xl'], // was 14, rounded to 16 (2xl)
    padding: space.px5,
    borderWidth: 1,
    borderColor: colors.rim,
    alignItems: 'center',
    gap: space.px2,
  },
  logoWrap: { marginBottom: space.px1 },
  logoImg: { width: 84, height: 84, borderRadius: 42, backgroundColor: colors.ink }, // off-scale: 84 (avatar size); off-scale radius: 42 (avatar)
  logoFallback: {
    width: 84, height: 84, borderRadius: 42, // off-scale: 84 (avatar size); off-scale radius: 42 (avatar)
    backgroundColor: colors.ink,
    borderWidth: 1, borderColor: colors.rim,
    alignItems: 'center', justifyContent: 'center',
  },
  logoEmoji: { fontSize: 38 }, // off-scale font: 38 (large emoji)
  restaurantName: { fontSize: text.lg, fontWeight: fontWeight.extrabold, color: colors.tx, textAlign: 'center' }, // was 18, rounded to 17 (lg)
  ownerName: { fontSize: text.sm, color: colors.dim },
  versionText: { fontSize: text.xs, color: colors.mute, marginTop: space.px2 }, // was fontSize 11, rounded to 11.5 (xs); marginTop 6, rounded to 8 (px2)

  logoutBtn: {
    backgroundColor: colors.red,
    paddingVertical: space.px4, // was 14, rounded to 16 (px4)
    borderRadius: radius.xl,
    alignItems: 'center',
  },
  logoutBtnText: { color: '#fff', fontSize: text.md, fontWeight: fontWeight.bold },

  linkWrap: { paddingHorizontal: space.px2, paddingVertical: space.px3 },
  linkText: { fontSize: text.xs, color: colors.dim, textAlign: 'center', lineHeight: 18 }, // was 12, rounded to 11.5 (xs)
});
