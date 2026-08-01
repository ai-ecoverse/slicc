# CLAUDE.md

This file covers the shared tray-session sync library in `packages/swift-traysession/`.

## Scope

`SliccTraySession` is a Foundation-only SPM library for cross-device discovery of active tray join URLs over iCloud key-value sync. The macOS launcher (`packages/swift-launcher`) is the producer and today's only consumer; the iOS follower (`packages/ios-app`) is the intended second consumer for iCloud session discovery (#1791) and does not depend on it yet. Supports `.macOS(.v14)` and `.iOS(.v17)`; **nothing here may import AppKit or UIKit** — CI builds the package for the iOS Simulator to enforce that.

## Contents

- `Sources/SliccTraySession/SyncedTraySession.swift` — one advertised session: `id` (**SHA-256 of the join URL**: opaque, so safe in accessibility ids / telemetry; the raw `joinUrl` carries the session secret and is never surfaced), `joinUrl`, `label`, `deviceId` (per-device UUID for ownership), `deviceName`, `createdAt`, `lastSeenAt`, `isStale(ttl:now:)`. CryptoKit + Foundation only; legacy payloads without `deviceId` decode empty.
- `Sources/SliccTraySession/TraySessionSyncStore.swift` — `@Observable` store over a `KeyValueSyncBackend` (default `UbiquitousKeyValueBackend` = iCloud KVS; tests inject `InMemoryKeyValueBackend`). **Each device writes its own key `storageKeyPrefix + deviceId` and reads the union**, so concurrent publishes never clobber; `withdrawLocalSessions()` clears only this device's key. Prunes stale by `defaultTTL` (12h), caps at `maxSessions` (64), observes the backend's external-change notification. Pure `active(from:)` / `upsert(_:into:)` are static and unit-tested.

`currentDeviceName()` uses `Host` (macOS-only Foundation) behind `#if os(macOS)`; iOS callers pass their own `deviceName:` at init instead.

Consumer wiring, producer lifecycle, the headless CLI consent gate, and the iCloud provisioning story (`ubiquity-kvstore-identifier`, `S8LB56P782.ai.sliccy.trays`) are launcher concerns — see `packages/swift-launcher/CLAUDE.md` § "iCloud Sync (Tray Sessions)".

## Build and Test Commands

```bash
cd packages/swift-traysession
swift build
swift test
npm run lint -w @slicc/swift-traysession   # SwiftLint
```

CI (`swift-traysession` job) runs SwiftLint, `swift format lint --strict`, a release build, an **iOS Simulator build** (catches AppKit/UIKit imports and macOS-only Foundation API), the coverage gate against the `swift-traysession` floors in `coverage-thresholds.json`, and an informational Periphery scan. The `swift-launcher` CI job also triggers on changes here, since the launcher consumes this package.

## Linting and Formatting

`.swiftlint.yml` inherits the shared rule set from the repo-root `.swiftlint.yml` (via `parent_config`) and excludes this package's `.build`. Formatting is `swift format` against the repo-root `.swift-format`:

```bash
npm run lint:format -w @slicc/swift-traysession   # swift format lint --strict (CI gate)
npm run format -w @slicc/swift-traysession        # swift format --in-place
```
