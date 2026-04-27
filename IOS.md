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

## TestFlight handoff

If your friend is helping from a Mac, this is the quickest path to an iPhone share link:

1. Open the project in Xcode with:

   ```bash
   npm run ios:open
   ```

2. In Xcode:
   - select the `App` target
   - set a unique bundle identifier if needed
   - choose the Apple developer team
   - set the version and build number

3. Build once to a physical iPhone to confirm sign-in, camera, and local network access.

4. In Xcode, choose:

   ```text
   Product -> Archive
   ```

5. In Organizer, choose:
   - `Distribute App`
   - `App Store Connect`
   - `Upload`

6. In App Store Connect:
   - open the app
   - open the `TestFlight` tab
   - add tester notes
   - invite internal testers or create a public testing link

## Ready-to-paste TestFlight notes

### Beta App Description

Inventory helps small shops track parts, locations, stock counts, workorder-linked usage, labels, backups, and offline transfer packages.

### What To Test

- sign in with the default users
- add and edit parts
- scan a barcode
- print labels
- change stock counts
- link inventory to workorders
- export and import a transfer package
- test offline/local mode

### Feedback Email

Use your real shop or project email here before upload.

## Server URL

When running on an iPhone, do not use `localhost` for the backend. Use the PC server URL shown in the app tools panel, for example:

```text
http://192.168.1.158:3001
```

The backend server must be running on the PC, and the iPhone must be on the same Wi-Fi network.
