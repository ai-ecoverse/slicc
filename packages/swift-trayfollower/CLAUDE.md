# CLAUDE.md

This file covers the shared tray-follower transport library in `packages/swift-trayfollower/` — the SPM package `SliccTrayFollower`.

## Scope

`SliccTrayFollower` is the headless tray-follower transport (signalling + WebRTC + tray-sync protocol mirror + chunk framing), shared by the iOS app (`packages/ios-app`, the `SliccFollower` app) and swift-server (`packages/swift-server`, Sliccstart, for egress-blocked Electron apps like Signal). It exists so those two consumers share **one** copy of the transport source on **one** `stasel/WebRTC` (151.x) — the framework and the source are not double-shipped. It is deliberately a **separate package** from `packages/swift-traysession` so that Foundation-only consumers (`swift-launcher`) never pull in WebRTC. Supports `.macOS(.v14)` and `.iOS("18.0")`.

It is **CDP-agnostic**: a consumer layers its own servicing on top of `TrayFollowerConnector`'s `didConnect(channelSend:)` / `didReceiveData:` surface — the iOS app renders chat/sprinkles/CDP; swift-server relays the attached app's raw CDP ("CDP over CDP"). The follower is always the **answerer** (the leader creates the offer + the data channel).

## Contents

- `Networking/TrayFollowerConnector.swift` — orchestrates one connection: attach loop → `TRAY_SUPERSEDED` redirect → bootstrap poll → answer the leader's WebRTC offer → data-channel open, with exponential-backoff auto-reconnect. Delivers the send closure + inbound data to its `TrayFollowerConnectorDelegate`. Its `didGenerateCandidate` names `RTCIceCandidate`, so a conformer must `import WebRTC`.
- `Networking/WebRTCManager.swift` — the `RTCPeerConnection` + data-channel wrapper. `Networking/TraySignaling.swift` — the HTTP bootstrap client (attach/poll/answer/ICE/retry) + the `FollowerAttachPlan` / `FollowerBootstrapPlan` decode types. `Networking/SupersedeRedirect.swift` — the pure supersede chain policy (gated on the replacement address, never on the failure code); `Networking/SupersedeLink.swift` — the RFC 5829 `successor-version` `Link` reading (#1957), twinned with `packages/swift-traysession`'s copy because that package stays dependency-free; both pin the same vectors as `shared-ts` and the Go CLI.
- `Models/SyncProtocol.swift` — the `Codable` mirror of a **subset** of `packages/shared-ts/src/tray-sync-protocol.ts` (`LeaderToFollowerMessage` / `FollowerToLeaderMessage` unions, `RemoteTargetInfo`, `TrayChunkFrame`, `traySyncProtocolVersion`), enforced by the golden corpus in `packages/ios-app` (`SyncProtocolCorpusTests`). `Models/TrayChunkFraming.swift` — transport chunk split/reassembly (below the message unions). `Models/{ChatMessage,LickEvent,TrayFs,TrayTypes}.swift` — chat/lick/fs/signaling payload types + `AnyCodable`.

## Consumption

The iOS app re-exports it module-wide from `SliccTrayKit/TrayFollowerExports.swift` (`@_exported import SliccTrayFollower`), so `import SliccTrayKit` still sees these types unqualified; swift-server imports `SliccTrayFollower` directly. Tests that reach an **internal** member (`@testable`) must import `SliccTrayFollower` directly and link its framework — see `packages/ios-app/project.yml` (the `SliccFollowerTests` dependency). The XcodeGen `packages:` block declares `SliccTrayFollower` at `path: ../swift-trayfollower`.

## Protocol mirror

`Models/SyncProtocol.swift` mirrors a subset of the canonical wire contract in `packages/shared-ts/src/tray-sync-protocol.ts`. When the protocol changes, this file, the golden corpus (`packages/webapp/src/scoops/tray-sync-protocol-corpus.ts` — decoded by both vitest and iOS `SyncProtocolCorpusTests`), and the `docs/architecture.md` matrix move together. `Models/TrayChunkFraming.swift` mirrors the framing half (`TrayChunkFrame` sits below the union — no corpus fixture).

## Build and Test Commands

```bash
cd packages/swift-trayfollower
swift build
swift test
npm run lint -w @slicc/swift-trayfollower   # SwiftLint (if a package.json script exists) — else `swiftlint lint`
```

CI (`swift-trayfollower` job) runs SwiftLint, `swift format lint --strict`, a release build, an **iOS Simulator build** (`SliccTrayFollower` scheme — catches AppKit/UIKit imports and macOS-only Foundation API; WebRTC ships simulator slices), the coverage gate against the `swift-trayfollower` floors in `coverage-thresholds.json`, and an informational Periphery scan. The `swift-server` and `ios-app` jobs also trigger on changes here, since both consume this package.

**Coverage** is measured by `swift test` over the pure-logic surface: the `Codable` protocol mirror, chunk framing, `SupersedeRedirect`, and the payload types. The live WebRTC (`WebRTCManager`), the connection loop (`TrayFollowerConnector`), and live HTTP (`TraySignalingClient`) need a real peer/server and are not unit-tested, so the floor reflects the testable surface.

## Linting and Formatting

`.swiftlint.yml` inherits the shared rule set from the repo-root `.swiftlint.yml` (via `parent_config`) and excludes `.build`. Formatting is `swift format` against the repo-root `.swift-format`.
