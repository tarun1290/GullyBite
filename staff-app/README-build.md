# GullyBite Staff — Building & Distributing the APK

The staff app is an Expo-managed React Native project. Release APKs are
produced by GitHub Actions — there is no EAS account, no Expo login,
and no Expo servers involved in the signed build.

## Prerequisites (one-time)

1. Complete **[README-keystore.md](./README-keystore.md)** — generate
   the release keystore and add the four repo secrets.
2. The repository must contain this `staff-app/` tree at the repo root
   alongside `frontend/` and `backend/`. The workflow file
   at [`.github/workflows/build-android-staff.yml`](../.github/workflows/build-android-staff.yml)
   runs with `working-directory: staff-app`; only `staff-app/**` path
   changes (or a manual trigger) kick off the job — pushes that touch
   only `frontend/` or `backend/` do not rebuild the APK.

## Trigger a build

Two ways:

- **Push to `main`** that touches any file under `staff-app/` (or the
  workflow file itself) kicks off `build-android-staff.yml`.
- **Manual** — open GitHub → **Actions → Build Android Staff APK → Run
  workflow** from the branch of your choice.

A run takes roughly **10–15 minutes** the first time (dependencies,
Gradle downloads) and 6–10 minutes thereafter (CI caches warm up).

## Download the APK

When the run finishes:

1. Open the workflow run page in GitHub.
2. Scroll to **Artifacts**.
3. Download **`GullyBite-Staff-Release`** — it contains
   `app-release.apk`. Extract the zip.

## Install on a staff device

Send `app-release.apk` to the restaurant — WhatsApp, email, or a shared
drive link all work.

On the Android phone:
1. Open the APK (Files / Downloads / wherever it landed).
2. Tap **Install**.
3. If prompted, allow **"Install from Unknown Sources"** for the app
   that opened the APK (file manager, Drive, etc.). Android will remember
   this choice.
4. Open the **branch staff-login link** the manager sends you (looks
   like `https://gullybite.duckdns.org/staff/<token>`). The link opens
   GullyBite Staff with the branch's access token already supplied.
5. Enter your **name** (as registered in the owner dashboard) and the
   **4-digit PIN** the manager assigned you.
6. Tap **Allow** on the notification permission prompt — this lets the
   phone chime for new orders even with the screen off.

## Troubleshooting

- **"App not installed" / signature mismatch:** a previous APK from a
  different keystore is already on the device. Uninstall it first.
- **No push alerts when backgrounded:** check Android battery settings
  — tell the OS to *not* optimise battery usage for GullyBite Staff, and
  re-confirm the notification permission.
- **PIN says "Invalid":** confirm with the owner that the slug and PIN
  are current. Regenerating a PIN in the admin dashboard invalidates
  the old one.
- **"Reconnecting…" pill won't go green:** the phone can't reach the
  backend. Check Wi-Fi / data, then pull-to-refresh the orders list.

## Updating the app

Push a new commit to `main` → wait for the Action → download and share
the new APK. Because every build uses the same keystore, Android will
install the new APK on top of the old one and keep the saved PIN session.
