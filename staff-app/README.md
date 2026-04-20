# GullyBite Staff — Android App

Expo-managed React Native app that restaurant staff install on a tablet
or phone to receive live orders, update order status, and toggle menu
item availability.

Built against the backend staff API (`/api/staff/*`) introduced with the
PIN-auth + SSE + push-token patch.

## Stack

- **Expo SDK 52** (managed workflow, no EAS)
- **expo-router** for file-based navigation
- **TypeScript** throughout
- **react-native-sse** for authenticated SSE (so we can set
  `Authorization` — raw browser `EventSource` can't)
- **expo-secure-store** for the staff JWT
- **expo-av** for the new-order chime
- **expo-notifications** for local + Expo push notifications

## Local development

```bash
cd staff-app
npm install
npx expo start
```

Scan the QR with **Expo Go** on an Android phone.

Set `EXPO_PUBLIC_API_URL` in a `.env` file (or your shell) to point at
the backend:

```
EXPO_PUBLIC_API_URL=https://gullybite.duckdns.org
```

## Release build

Release APKs come out of GitHub Actions, not EAS. See:

- **[README-keystore.md](./README-keystore.md)** — one-time keystore setup + repo secrets
- **[README-build.md](./README-build.md)** — triggering builds and distributing APKs

## Project layout

```
staff-app/
├── app/                          # expo-router file-based routes
│   ├── _layout.tsx               # root layout + auth guard + push handler
│   ├── index.tsx                 # redirect placeholder
│   ├── login.tsx                 # PIN login screen
│   └── (tabs)/
│       ├── _layout.tsx           # bottom tab bar
│       ├── orders.tsx            # live orders + SSE + sound
│       └── menu.tsx              # availability toggles
├── src/
│   ├── api.ts                    # typed fetch helpers
│   ├── storage.ts                # SecureStore wrapper (JWT + restaurant info)
│   ├── sse.ts                    # SSE client with exponential backoff
│   ├── push.ts                   # Expo push registration
│   ├── sound.ts                  # expo-av chime
│   ├── deviceId.ts               # stable per-device ID
│   ├── theme.ts                  # colours + status badges
│   ├── time.ts                   # timeAgo / formatRs
│   └── components/
│       ├── Keypad.tsx            # custom numeric keypad
│       └── OrderCard.tsx         # order card with status transitions
├── assets/                       # icons, splash, notification icon, chime
├── scripts/
│   └── patch-gradle-signing.js   # post-prebuild gradle signing patch
├── .github/workflows/
│   └── build-android.yml         # unsigned-free APK build
├── app.config.js                 # dynamic Expo config
├── babel.config.js
├── tsconfig.json
└── package.json
```

## Key behaviours

- **Login**: custom keypad only — the system keyboard is never summoned
  for PIN entry. Shakes and clears on invalid PIN. Slug auto-lowercases.
- **Orders**: SSE connection shows a **Live / Reconnecting…** pill.
  Exponential backoff `1s → 2s → 4s → 8s → 16s → 30s`. Every successful
  reconnect re-fetches the list so nothing is missed.
- **New order event**: prepends to the list with a brief highlight
  animation, plays the chime via `expo-av`, and schedules a local
  notification so the alert surfaces even when backgrounded.
- **Menu**: optimistic toggle with rollback on failure, bottom toast
  confirms each update, search bar filters across categories.
- **Auth**: token + restaurant stored in `SecureStore`. App launch
  checks JWT expiry and skips the login screen if still valid. Logout
  clears both keys and bounces back to login.
- **Push**: permission requested on first successful login. Token is
  registered via `POST /api/staff/push-token` with a stable device ID.
  Foreground handler shows banner + sound (`shouldShowAlert`,
  `shouldPlaySound`, `shouldSetBadge` all true). Tapping a `new_order`
  notification while backgrounded routes the user to the Orders tab.

## Adding real assets

See [`assets/README.md`](./assets/README.md) — placeholder PNGs and an
empty MP3 ship so the bundler resolves; swap in real artwork before
your first release build.
