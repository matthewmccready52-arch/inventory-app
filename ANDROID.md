# Android Build Notes

The Android project is scaffolded with Capacitor under `client/android`.

## Current setup

- App id: `com.matthewmccready.inventory`
- App name: `Inventory`
- Web build output: `client/dist`
- Android camera permission is enabled.
- Cleartext local-network HTTP is enabled so the APK can talk to the local backend, such as `http://192.168.1.158:3001`.

## Build prerequisites

Install:

1. Android Studio
2. Android SDK from Android Studio
3. Java/JDK, usually installed with Android Studio

After installation, reopen PowerShell and confirm:

```powershell
java -version
```

## Build and open

From the project:

```powershell
cd "C:\Users\Matth\Documents\Codex\2026-04-18-im-building-an-app-in-chat\Inventory app\client"
npm run cap:sync
npm run android:open
```

In Android Studio, build a debug APK from:

```text
Build > Build Bundle(s) / APK(s) > Build APK(s)
```

## Backend URL in the app

The Android app needs to reach the backend running on the computer. In the app's Tools panel, set:

```text
http://YOUR-COMPUTER-IP:3001
```

For the current network that was detected earlier, that was:

```text
http://192.168.1.158:3001
```

If your Wi-Fi changes, this IP may change.
