# CLAUDE.md

This file covers the shared tray-session sync library in `packages/swift-traysession/` (the Foundation-only `SliccTraySession`). The WebRTC-bearing tray-follower transport is a **separate package**, `packages/swift-trayfollower` (`SliccTrayFollower`) — see [`packages/swift-trayfollower/CLAUDE.md`](../swift-trayfollower/CLAUDE.md).

## Scope

`SliccTraySession` is a Foundation-only SPM library for cross-device discovery of tray join URLs over iCloud key-value sync. Two namespaces: **live sessions** (`TraySessionSyncStore`) — the macOS launcher (`packages/swift-launcher`) publishes, the iOS follower (`packages/ios-app`) reads (the phone joins sessions, it never publishes one) — and **recents** (`RecentJoinStore`), where every consumer both writes and reads, because a hand-pasted join URL is advertised by nobody. Supports `.macOS(.v14)` and `.iOS("18.0")`; **nothing here may import AppKit or UIKit** — CI builds the package for the iOS Simulator to enforce that.

## Contents

- `Sources/SliccTraySession/SyncedTraySession.swift` — one advertised session: `id` (**SHA-256 of the join URL**: opaque, so safe in accessibility ids / telemetry; the raw `joinUrl` carries the session secret and is never surfaced), `joinUrl`, `label`, `deviceId` (per-device UUID for ownership), `deviceName`, `createdAt`, `lastSeenAt`, `isStale(ttl:now:)`. CryptoKit + Foundation only; legacy payloads without `deviceId` decode empty.
- `Sources/SliccTraySession/TraySessionSyncStore.swift` — `@Observable` store over a `KeyValueSyncBackend` (default `UbiquitousKeyValueBackend` = iCloud KVS; tests inject `InMemoryKeyValueBackend`). **Each device writes its own key `storageKeyPrefix + deviceId` and reads the union**, so concurrent publishes never clobber; `withdrawLocalSessions()` clears only this device's key. Prunes stale by `defaultTTL` (12h), caps at `maxSessions` (64), observes the backend's external-change notification. Pure `active(from:)` / `upsert(_:into:)` are static and unit-tested.
- `Sources/SliccTraySession/RecentJoinStore.swift` — `RecentJoin` (same SHA-256-of-join-URL `id` as `SyncedTraySession`, so a recent and the live session it came from are one identity; `displayHost` is the only renderable part of the URL) plus an `@Observable` store over the same `KeyValueSyncBackend`, keyed `recentJoins.v1.<deviceId>`. Recorded on a **successful** connection, so a typo'd paste never syncs. Per-device keys + union reads as above; each device persists at most `maxRecents` (5), the merged pool is capped at `maxPooled` (20), TTL is 30 days (history, not liveness). `rank(_:limit:isReachable:)` orders reachable-first then newest-connected and applies the five-row cap **after** ranking, so a live older session displaces a dead newer one; ties break on `id` so redraws cannot reshuffle. `clearLocalHistory()`/`forget(id:)` clear only this device's key — another device's copy can sync back.
- `Sources/SliccTraySession/SessionReachability.swift` — shared `@Observable` liveness probe used by the native consumers. It follows up to five HTTP 409 `TRAY_SUPERSEDED` replacement hops and reports reachable only when the terminal HTTP 200 body has `leader.connected == true`; raw status alone is never a liveness signal. Requests append the load-bearing `json=true`, use a four-second per-hop timeout by default, deduplicate in-flight probes by opaque session id, and never log or persist replacement join URLs. Because the replacement is discarded, **a consumer's join path must follow the same chain itself** — otherwise a probe-reachable row refuses to connect (the same `TRAY_SUPERSEDED` handling `SupersedeRedirect.swift` in `packages/swift-trayfollower` gives the follower join path; the launcher inherits it from the webapp follower's `tray-webrtc.ts`). Probing is generic over `ProbableSession`, which both `SyncedTraySession` and `RecentJoin` conform to.

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
