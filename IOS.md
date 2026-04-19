# iPhone build notes

The iOS project is generated with Capacitor under `client/ios`.

## What is already done

- `@capacitor/ios` is installed.
- The iOS native project has been added.
- Camera permission text is configured for barcode scanning.
- Local network permission text is configured for connecting to the inventory server on your LAN.
- App Transport Security is relaxed so the app can call the local HTTP backend, such as `http://192.168.1.158:3001`.

## Build on a Mac

Apple requires macOS and Xcode to build or install an iPhone app.

1. Install Xcode from the Mac App Store.
2. Clone this repo on the Mac.
3. From `client`, install dependencies:

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

When running on an iPhone, do not use `localhost` for the backend. Use the PC server URL shown in the app tools panel, for example:

```text
http://192.168.1.158:3001
```

The backend server must be running on the PC, and the iPhone must be on the same Wi-Fi network.
