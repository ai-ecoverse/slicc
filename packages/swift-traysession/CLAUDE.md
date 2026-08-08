# CLAUDE.md

This file covers the shared tray library in `packages/swift-traysession/`. It ships **two products**:

- **`SliccTraySession`** — Foundation-only iCloud tray-session discovery (below).
- **`SliccTrayFollower`** — the headless tray-follower transport (signalling + WebRTC + tray-sync protocol mirror + chunk framing), shared by the iOS app and swift-server so the WebRTC framework and the transport source are not double-shipped.

They are deliberately **separate products**: `SliccTraySession` stays Foundation-only (so `swift-launcher` never pulls in WebRTC), and only `SliccTrayFollower` depends on `stasel/WebRTC`.

## Scope

`SliccTraySession` is a Foundation-only SPM library for cross-device discovery of active tray join URLs over iCloud key-value sync. The macOS launcher (`packages/swift-launcher`) is the producer; the iOS follower (`packages/ios-app`) consumes it read-only for iCloud session discovery (the phone joins sessions, it never publishes one). Supports `.macOS(.v14)` and `.iOS("18.0")`; **nothing in `SliccTraySession` may import AppKit or UIKit** — CI builds the `SliccTraySession` scheme for the iOS Simulator to enforce that (the WebRTC-bearing `SliccTrayFollower` is not in that scheme, so it does not gate on it).

## Contents

- `Sources/SliccTraySession/SyncedTraySession.swift` — one advertised session: `id` (**SHA-256 of the join URL**: opaque, so safe in accessibility ids / telemetry; the raw `joinUrl` carries the session secret and is never surfaced), `joinUrl`, `label`, `deviceId` (per-device UUID for ownership), `deviceName`, `createdAt`, `lastSeenAt`, `isStale(ttl:now:)`. CryptoKit + Foundation only; legacy payloads without `deviceId` decode empty.
- `Sources/SliccTraySession/TraySessionSyncStore.swift` — `@Observable` store over a `KeyValueSyncBackend` (default `UbiquitousKeyValueBackend` = iCloud KVS; tests inject `InMemoryKeyValueBackend`). **Each device writes its own key `storageKeyPrefix + deviceId` and reads the union**, so concurrent publishes never clobber; `withdrawLocalSessions()` clears only this device's key. Prunes stale by `defaultTTL` (12h), caps at `maxSessions` (64), observes the backend's external-change notification. Pure `active(from:)` / `upsert(_:into:)` are static and unit-tested.
- `Sources/SliccTraySession/SessionReachability.swift` — shared `@Observable` liveness probe used by the native consumers. It follows up to five HTTP 409 `TRAY_SUPERSEDED` replacement hops and reports reachable only when the terminal HTTP 200 body has `leader.connected == true`; raw status alone is never a liveness signal. Requests append the load-bearing `json=true`, use a four-second per-hop timeout by default, deduplicate in-flight probes by opaque session id, and never log or persist replacement join URLs. Because the replacement is discarded, **a consumer's join path must follow the same chain itself** — otherwise a probe-reachable row refuses to connect (the same `TRAY_SUPERSEDED` handling `Sources/SliccTrayFollower/Networking/SupersedeRedirect.swift` gives the follower join path; the launcher inherits it from the webapp follower's `tray-webrtc.ts`).

`currentDeviceName()` uses `Host` (macOS-only Foundation) behind `#if os(macOS)`; iOS callers pass their own `deviceName:` at init instead.

Consumer wiring, producer lifecycle, the headless CLI consent gate, and the iCloud provisioning story (`ubiquity-kvstore-identifier`, `S8LB56P782.ai.sliccy.trays`) are launcher concerns — see `packages/swift-launcher/CLAUDE.md` § "iCloud Sync (Tray Sessions)".

## SliccTrayFollower (shared follower transport)

`Sources/SliccTrayFollower/` is the headless tray-follower transport, extracted from the iOS app's `SliccTrayKit` so `packages/ios-app` (the `SliccFollower` app) and `packages/swift-server` (Sliccstart, for egress-blocked Electron apps like Signal) share one copy on one `stasel/WebRTC` (150.x). It is CDP-agnostic: consumers layer their own servicing on top of `TrayFollowerConnector`'s `didConnect(channelSend:)` / `didReceiveData:` surface (iOS renders chat/sprinkles/CDP; swift-server relays the app's raw CDP — "CDP over CDP").

- `Networking/TrayFollowerConnector.swift` — orchestrates one connection: attach loop → `TRAY_SUPERSEDED` redirect → bootstrap poll → answer the leader's WebRTC offer → data channel open, with exponential-backoff auto-reconnect. Delivers the send closure and inbound data to its `TrayFollowerConnectorDelegate`. Its `didGenerateCandidate` names `RTCIceCandidate`, so a conformer must `import WebRTC`.
- `Networking/WebRTCManager.swift` — the `RTCPeerConnection` + data-channel wrapper (the follower is always the answerer). `Networking/TraySignaling.swift` — the HTTP bootstrap client (attach/poll/answer/ICE/retry). `Networking/SupersedeRedirect.swift` — the `TRAY_SUPERSEDED` chain policy.
- `Models/SyncProtocol.swift` — the `Codable` mirror of a subset of `packages/shared-ts/src/tray-sync-protocol.ts` (message unions, `RemoteTargetInfo`, `TrayChunkFrame`, `traySyncProtocolVersion`), enforced by the golden corpus in `packages/ios-app` (`SyncProtocolCorpusTests`). `Models/TrayChunkFraming.swift` — transport chunk split/reassembly. `Models/{ChatMessage,LickEvent,TrayFs,TrayTypes}.swift` — chat/lick/fs/signaling payload types + `AnyCodable`.

**Consumption:** the iOS app re-exports it module-wide from `SliccTrayKit/TrayFollowerExports.swift` (`@_exported import SliccTrayFollower`), so `import SliccTrayKit` still sees these types; swift-server imports `SliccTrayFollower` directly. Tests that reach an _internal_ member (`@testable`) must import `SliccTrayFollower` directly and link its framework — see `packages/ios-app/project.yml` (the `SliccFollowerTests` dependency).

**Coverage caveat:** because `SliccTrayFollower` sits under this package but is exercised only by the iOS app's tests, it is measured by **neither** gate — swift-traysession's test binary doesn't link it (its test target depends only on `SliccTraySession`), and the ios-app gate's positional source-path filter excludes files outside `packages/ios-app`. The tests still run (in ios-app); the module is just not floor-gated. A follow-up should add a `SliccTrayFollower` test target here (moving the pure-logic protocol/framing tests over) to restore a floor.

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
