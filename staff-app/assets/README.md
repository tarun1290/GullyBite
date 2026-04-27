# Bundled Assets

These files are baked into the APK by `expo prebuild`. Drop real assets
in before the first build — placeholders will work but look drab.

## Required

| Path | Role | Notes |
|---|---|---|
| `icon.png` | Square app icon | 1024×1024 PNG, no transparency. |
| `adaptive-icon.png` | Android 8+ foreground layer | 1024×1024 PNG, *keep the artwork inside the centre 66%* — the OS crops the rest. Background colour is set in `app.config.js` (`#4338ca`). |
| `splash.png` | Splash screen | 1284×2778 PNG (iPhone 13 Pro Max size is fine as a safe upper bound). Expo centres it. |
| `notification-icon.png` | Android status-bar push icon | 96×96 PNG, white silhouette on transparent background. Required by the `expo-notifications` plugin. |
| `sounds/new_order.mp3` | New-order chime | Short (≤ 2 s), attention-grabbing. Played via `expo-av` when an SSE `new_order` event arrives and referenced via `require()` in `src/sound.ts`. |

## Quick starter chime

If you don't have a file handy yet, grab any royalty-free notification
sound (e.g. from <https://freesound.org>) and rename it to
`sounds/new_order.mp3`. Keep it short and loud.

The `src/sound.ts` loader swallows "asset missing" errors silently, so
the app will still build if you forget — you just won't hear anything.
