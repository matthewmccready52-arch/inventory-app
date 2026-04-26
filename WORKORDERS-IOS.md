# Workorders iPhone build notes

The separate Workorders app now has a Capacitor iOS project under `workorders-client/ios`.

## What is already done

- `@capacitor/ios` is installed.
- The native iPhone project has been added.
- Camera permission text is configured for intake photos and barcode scanning.
- Microphone permission text is configured for voice-to-text notes.
- Speech recognition permission text is configured for dictation.
- Local network permission text is configured for connecting to the shop server on your LAN.
- App Transport Security is relaxed so the app can call a local HTTP backend such as `http://192.168.1.158:3001`.

## Build on a Mac

Apple requires macOS and Xcode to build or install an iPhone app.

1. Install Xcode from the Mac App Store.
2. Clone this repo on the Mac.
3. From `workorders-client`, install dependencies:

   ```bash
   npm install
   ```

4. Build and sync the iOS app:

   ```bash
   npm run ios:sync
   ```

5. Open the iOS project:

   ```bash
   npm run ios:open
   ```

6. In Xcode, select the `App` target, choose your Apple developer team, connect your iPhone, then press Run.

## Server URL

When running on an iPhone, do not use `localhost` for the backend. Use the PC server URL shown in the app, for example:

```text
http://192.168.1.158:3001
```

The backend server must be running on the PC, and the iPhone must be on the same Wi-Fi network.
