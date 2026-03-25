# CLAUDE.md

This file covers the native macOS server in `packages/swift-server/`.

## Scope

`packages/swift-server/` is a Hummingbird-based standalone server that serves the built UI, launches Chrome/Electron, proxies CDP, and exposes the lick WebSocket/event surface.

## Build and Test Commands

```bash
cd packages/swift-server
swift build
swift test
swift run slicc-server --help
```

## Main Package Layout

- `Sources/Browser/` — Chrome and Electron launchers plus console forwarding
- `Sources/CLI/` — `ServerCommand` argument parsing and runtime bootstrap
- `Sources/Server/` — HTTP routes, static file middleware, request logging, shutdown
- `Sources/WebSocket/` — CDP proxy and lick WebSocket system
- `Tests/` — package tests

## Server Overview

- `CLI/ServerCommand.swift` is the entry point and mirrors the major Node runtime flags.
- The server resolves ports, launches or attaches to a browser target, and serves `dist/ui` through `StaticFileMiddleware`.
- `WebSocket/CDPProxy.swift` exposes the CDP proxy to browser clients.
- `WebSocket/LickSystem.swift` keeps a set of connected browser clients, sends request/response messages, and broadcasts lick events.

## API Routes

`Sources/Server/APIRoutes.swift` is the main route registry. Important routes include:

- `GET /api/runtime-config`
- `GET /api/tray-status`
- `GET|POST|DELETE /api/webhooks...`
- `GET|POST|DELETE /api/crontasks...`
- `GET /auth/callback`
- `GET|POST /api/oauth-result`
- `ALL /api/fetch-proxy`

WebSocket routes are installed separately for CDP proxying and the lick system.

## Static File Serving

- Static assets are served from `dist/ui`.
- Keep the web build output in sync before debugging server-side serving behavior.

## Lick / WebSocket System

- `LickSystem` is an actor that tracks connected browser clients and pending requests.
- `LickWebSocketRoute` exposes the `/licks-ws` endpoint.
- Browser-originated messages resolve pending requests or broadcast events back into the runtime.

## Related Guides

- `packages/node-server/CLAUDE.md` for the parallel Node runtime
- `docs/development.md` for broader run/debug workflow guidance
