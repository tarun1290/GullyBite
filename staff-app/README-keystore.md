# Android Keystore — One-Time Setup

Android requires every release APK to be signed by a stable keystore. Do
this once, locally, **before** running the first build. Re-using the same
keystore for every subsequent release is mandatory — a new keystore means
existing installs can't be updated.

## 1. Generate the keystore

Requires any JDK with `keytool` on your PATH (JDK 17 recommended).

```bash
keytool -genkeypair -v \
  -keystore gullybite-staff-key.keystore \
  -alias gullybite-staff \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -storetype PKCS12
```

Answer the prompts. **Remember the keystore password and key password** —
they cannot be recovered. Store both in your password manager.

Keep `gullybite-staff-key.keystore` somewhere safe and *never commit it* to
the repo. The project `.gitignore` already excludes `*.keystore`.

## 2. Base64-encode the keystore

The GitHub Action decodes this back into a real file inside the CI
runner. Produce the base64 string with:

```bash
# macOS — copies to clipboard:
base64 -i gullybite-staff-key.keystore | pbcopy

# Linux — prints to stdout:
base64 gullybite-staff-key.keystore
```

Take the result and paste it in the `STAFF_ANDROID_KEYSTORE_BASE64`
secret below. It should be a single line of ASCII.

## 3. Add repository secrets

In GitHub → **Settings → Secrets and variables → Actions → New repository
secret**, add exactly these four names:

| Secret | Value |
|---|---|
| `STAFF_ANDROID_KEYSTORE_BASE64` | base64-encoded contents of `gullybite-staff-key.keystore` |
| `STAFF_KEYSTORE_PASSWORD` | the keystore password you chose |
| `STAFF_KEY_ALIAS` | `gullybite-staff` |
| `STAFF_KEY_PASSWORD` | the key password you chose (often the same) |

`EXPO_PUBLIC_API_URL` is hard-coded in the workflow at
`https://gullybite.duckdns.org` — change it there (not as a secret) if
the backend host ever moves.

That's it. You don't need an Expo account or EAS setup — the build runs
purely with Node, Java 17, and Gradle on the GitHub runner.

## 4. Losing the keystore

If the keystore file is lost:
- You can still cut a *new* APK, but it will be a different identity and
  Android will refuse to install it as an update on existing devices.
- Staff will need to uninstall the old app and install the new one
  fresh (they keep no local data that matters — auth is behind a PIN).

Treat the keystore like a production credential. Back it up alongside
your password-manager records, not in the repo.
