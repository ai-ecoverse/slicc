# CLAUDE.md

This file covers the Swift Operational Telemetry / RUM library in `packages/swift-optel/`.

## Scope

`packages/swift-optel/` is a pure-Swift library (`SwiftOptel`) that will host the shared RUM / Operational Telemetry instrumentation consumed by the iOS follower app and the macOS native server / launcher. Skeleton only at this stage — actual RUM logic lands in later tasks. Supports `.iOS(.v16)` and `.macOS(.v13)`; no third-party dependencies.

## Build and Test Commands

```bash
cd packages/swift-optel
swift build
swift test
npm run lint -w @slicc/swift-optel   # SwiftLint
```

## Linting

`packages/swift-optel/.swiftlint.yml` inherits the shared rule set from the
repo-root `.swiftlint.yml` (via `parent_config`) and excludes this package's
`.build`. Run `npm run lint:fix -w @slicc/swift-optel` to auto-correct fixable
violations.

## Package Layout

- `Sources/SwiftOptel/` — library sources
- `Tests/SwiftOptelTests/` — package tests

## SwiftUI Auto-Instrumentation

Ergonomic hooks for the four RUM checkpoints a SwiftUI app cares about. All
SwiftUI surface lives in `OptelSwiftUI.swift` under `#if canImport(SwiftUI)`;
the mapping helpers (`OptelSourceDeriver`, `OptelErrorMapping`,
`OptelUncaughtExceptionHook`) are platform-agnostic and unit-tested.

- `.optelAutoInstrument(appID:rate:)` — root modifier. Configures `Optel`
  once, fires `enter` on launch, observes `scenePhase` and re-fires `enter`
  on `background → active` transitions, and installs the best-effort
  uncaught-exception hook.
- `.optelView(_:)` — emits `navigate` with `source = name` on `.onAppear`.
- `.optelTap(source:)` — attaches a `simultaneousGesture` that emits `click`
  with the supplied source.
- `OptelButton` — `Button` wrapper that derives `click` source from
  `(identifier, accessibilityLabel, context)` via `OptelSourceDeriver` into
  the `<context> <element>#<identifier>` shape.
- `Optel.reportError(_:)` — emits `error` with `source` = bridged NSError
  domain (or Swift type name) and `target` = `localizedDescription`.

### Interception limits (known, accepted)

- **No global tap / navigation interception.** SwiftUI has no AppKit/UIKit-
  style responder chain that third-party code can hook. Per-view opt-in is
  the only reliable surface — hence the `.optelView` / `.optelTap` /
  `OptelButton` per-control modifiers rather than a single magic root hook.
- **Uncaught-error hook is Objective-C only.** `NSSetUncaughtExceptionHandler`
  fires for `NSException`s; Swift `Error` values are not exceptions and cannot
  be intercepted globally. Catch and forward to `Optel.reportError(_:)`
  explicitly at the boundaries where you `try?` / `do/catch`.
- **`.optelAutoInstrument` covers launch and foregrounding only.** Background
  / suspend / inactive transitions are intentionally not mapped to RUM
  checkpoints (no helix-rum-js analogue).
- **`scenePhase` requires a `Scene` ancestor.** The root modifier must be
  applied inside the `WindowGroup` / `Scene` content (typically on the root
  view), not on the `App` itself, for `@Environment(\.scenePhase)` to update.
- **Reconfiguration resets state.** Calling `.optelAutoInstrument` on a
  remounted root view will re-`configure` `Optel` and re-fire `enter` (and a
  fresh session id). Mount it on a stable root.

## Related Guides

- `packages/swift-server/CLAUDE.md` for the native macOS server
- `packages/ios-app/CLAUDE.md` for the iOS follower app
