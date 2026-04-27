# TestFlight Handoff

Use this when a friend with a Mac is helping publish the iPhone beta.

## What they need

- a Mac with Xcode installed
- access to the GitHub repo
- an Apple Developer team that can sign the app
- an iPhone for a quick smoke test

## Repo paths

- Inventory iPhone project: `client/ios`
- Workorders iPhone project: `workorders-client/ios`

## Inventory app upload

1. Clone the repo
2. In `client`:

   ```bash
   npm install
   npm run ios:sync
   npm run ios:open
   ```

3. In Xcode:
   - select the `App` target
   - choose the Apple team
   - confirm bundle identifier
   - set version/build
   - run on an iPhone once
4. Archive and upload to App Store Connect
5. In TestFlight, paste the notes from [IOS.md](C:/Users/Matth/Documents/Codex/2026-04-18-im-building-an-app-in-chat/Inventory%20app/IOS.md)

## Workorders app upload

1. In `workorders-client`:

   ```bash
   npm install
   npm run ios:sync
   npm run ios:open
   ```

2. In Xcode:
   - select the `App` target
   - choose the Apple team
   - confirm bundle identifier
   - set version/build
   - run on an iPhone once
3. Archive and upload to App Store Connect
4. In TestFlight, paste the notes from [WORKORDERS-IOS.md](C:/Users/Matth/Documents/Codex/2026-04-18-im-building-an-app-in-chat/Inventory%20app/WORKORDERS-IOS.md)

## Quick smoke test list

- sign in
- camera permission prompt appears
- microphone / speech prompt appears in Workorders
- local/offline mode works
- transfer package export works
- print or customer copy export opens
- if server mode is used, entering the backend URL works
