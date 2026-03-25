# CLAUDE.md

This file covers the native macOS launcher in `packages/swift-launcher/`.

## Scope

`Sliccstart` is a SwiftUI launcher that finds supported browsers and Electron apps, starts the right SLICC runtime, and helps create debug-friendly Electron builds when needed.

## Build and Test Commands

```bash
cd packages/swift-launcher
swift build
swift test
swift run Sliccstart
npm run build
./sign-and-package.sh
```

## Main Package Layout

- `Sliccstart/` — SwiftUI app entry, models, and views
- `SliccstartTests/` — package tests
- `assemble-app.mjs` — assembles the `.app` bundle from compiled binaries
- `sign-and-package.sh` — signing/packaging helper

## App Overview

- `SliccstartApp.swift` boots the launcher UI.
- `Models/AppScanner.swift` finds Chromium browsers and CDP-capable desktop apps.
- `Models/SliccBootstrapper.swift` and `Models/SliccProcess.swift` handle runtime launch and lifecycle.
- `Views/` contains the launcher UI and setup/progress views.

## App Scanning

- Known Chromium browsers are discovered by bundle ID.
- `/Applications` is scanned for Electron or WebView2-style app bundles with CDP-capable frameworks.
- `~/Applications` is scanned first for `* Debug.app` builds so patched debug builds win over originals.

## Debug Build Creation

`Models/DebugBuildCreator.swift` creates Electron debug builds by:

1. copying the app into `~/Applications/<Name> Debug.app`
2. patching Electron fuses to allow remote debugging
3. unpacking and patching `app.asar` JavaScript checks that block CDP
4. ad-hoc signing the copied app
5. removing quarantine attributes

Use this path when an Electron app disables remote debugging in production builds.

## Packaging Notes

- `npm run build` compiles Swift and assembles the `.app` bundle for manual testing.
- `sign-and-package.sh` is the packaging path for distributable artifacts.
- When running from inside the repo, the launcher expects the webapp and extension artifacts to already be built and the Swift server to be available.