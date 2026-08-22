# CLAUDE.md

Shared leader VFS / File Provider library in `packages/swift-traykit/` — the SPM module `SliccTrayVFS`.

## Scope

`SliccTrayVFS` exposes the leader workspace to native file surfaces (iOS Files.app, macOS Finder) via `NSFileProviderReplicatedExtension`. Consumed by `packages/ios-app` (SliccFileProvider appex) and `packages/swift-launcher` (Sliccstart Finder appex). Depends on `SliccTrayFollower` for WebRTC transport and tray `fs.*` protocol types. Supports `.macOS(.v14)` and `.iOS("18.0")`; nothing here may import AppKit/UIKit.

## Contents

- `TrayCredentialStore.swift` + `TrayCredentialConfiguration.swift` — app-group defaults + keychain join URL for the appex (team-prefixed group on macOS).
- `Sync/FsClient.swift` — request/response correlator for tray `fs.*` against the leader VFS.
- `FileProvider/LeaderVFSProvider.swift` — `NSFileProvider` item/enumerator logic.
- `FileProvider/FileProviderTrayConnection.swift` — pooled WebRTC connection for the appex process.
- `FileProvider/FileProviderDomainLifecycle.swift` — `NSFileProviderManager` add/remove + `userEnabled` reset.

iOS re-exports via `SliccTrayKit/TrayVFSExports.swift` (`@_exported import SliccTrayVFS`).

## Build and Test

```bash
cd packages/swift-traykit
swift build
swift test
npm run lint -w @slicc/swift-traykit
```

CI: `swift-traykit` job (lint, format, macOS + iOS Simulator build, coverage gate).

## Caveats

- `readBinaryFile` holds full base64 + decoded `Data` in memory — large Finder drags may need streaming later.
- The mount is only useful while a leader is running; outages map to `NSFileProviderError.serverUnreachable`.
