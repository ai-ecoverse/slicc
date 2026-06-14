# CLAUDE.md

This file covers the Swift OpenTelemetry / RUM library in `packages/swift-optel/`.

## Scope

`packages/swift-optel/` is a pure-Swift library (`SwiftOptel`) that will host the shared RUM / OpenTelemetry instrumentation consumed by the iOS follower app and the macOS native server / launcher. Skeleton only at this stage — actual RUM logic lands in later tasks. Supports `.iOS(.v16)` and `.macOS(.v13)`; no third-party dependencies.

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

## Related Guides

- `packages/swift-server/CLAUDE.md` for the native macOS server
- `packages/ios-app/CLAUDE.md` for the iOS follower app
