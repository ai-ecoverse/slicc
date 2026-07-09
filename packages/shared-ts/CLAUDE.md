# @slicc/shared-ts

Platform-agnostic primitives shared across `@slicc/webapp`, `@slicc/node-server`, and `@slicc/chrome-extension`.

## Contents

- `secret-masking.ts` — HMAC-SHA256 masking, domain matching, scrubbing.
- `secrets-pipeline.ts` — stateful unmask/scrub class; Basic-auth-aware, URL-credential-aware, byte-safe body unmask.
- `oauth-extra-domains-storage.ts` — pure-JS read/write helpers over the `slicc_oauth_extra_domains` localStorage key. Lets the extension options page (`secrets.html`) share the per-provider extra-domains store with the webapp's `provider-settings.ts` without dragging in the heavier provider module.
- `sigv4.ts` — pure SigV4 v4 request signer over Web Crypto (`crypto.subtle`), no AWS SDK. Verified against the canonical AWS test vectors in `tests/sigv4.test.ts`.
- `tray-signaling.ts` — tray signaling wire contract (leader↔worker control messages, follower HTTP bootstrap request/response shapes, bootstrap retry constants). Single source of truth for `@slicc/webapp` and `@slicc/cloudflare-worker`; the iOS follower mirrors a subset in `packages/ios-app/SliccFollower/Models/TrayTypes.swift`. Worker-internal persisted state (`TrayBootstrapRecord`, `TrayRecord`) stays in `packages/cloudflare-worker/src/shared.ts`.
- `agent-wire-types.ts` — agent/chat wire payload types (`AgentEvent`, `ChatMessage`, `ToolCall`, `MessageAttachment`, `LickEvent`) embedded in the tray sync protocol. Types only; the producing/consuming behavior stays in `@slicc/webapp`, which re-exports them from their original layer-local modules.
- `tray-sync-protocol.ts` — tray sync data-channel wire contract (`LeaderToFollowerMessage` / `FollowerToLeaderMessage` unions, summary/target/FS types, `TRAY_SYNC_PROTOCOL_VERSION`, `unhandledProtocolMessage`). Partially mirrored by `packages/ios-app/SliccFollower/Models/SyncProtocol.swift` and enforced by the golden-fixture corpus (`packages/webapp/src/scoops/tray-sync-protocol-corpus.ts`). The `TraySyncChannel` runtime stays in `@slicc/webapp` `scoops/tray-sync-protocol.ts`.
- `bridge-protocol.ts` — standalone/Electron thin-bridge launch contract: `slicc.bridge.v1.` subprotocol prefix, `bridge`/`bridgeToken` query params, `X-Bridge-Token` header, and the **single source of truth** for the hosted origins (`SLICC_HOSTED_ORIGIN`, `SLICC_STAGING_HUB_ORIGIN`) that every TS package imports instead of hardcoding. The `lint:hosted-origin` gate (`packages/dev-tools/tools/check-hosted-origin-literal.mjs`) prevents raw literals from re-appearing. Swift mirror: `packages/swift-server/Sources/Server/BridgeSecurity.swift`.
- `sign-and-forward.ts` — S3 / Adobe da.live sign-and-forward orchestration (`executeS3SignAndForward` / `executeDaSignAndForward`). Validates an envelope, resolves credentials via an async `SecretGetter`, signs (S3) or attaches a Bearer token (DA), forwards, and returns a JSON-cloneable reply. Consumed by the webapp mount barrel, the node-server Express handlers (via a `SecretStore` adapter), and the extension service worker.

## Conventions

- Prefer universal globals (`crypto.subtle`, `TextEncoder`, `Headers`, `atob`/`btoa`) so one build runs unchanged in the browser, the extension service worker, and the Node 22+ server. A platform-specific fast-path is allowed when it is feature-detected and falls back to the universal implementation — e.g. `sign-and-forward.ts` base64 reaches Node's `Buffer` via `globalThis` behind a runtime feature check (materially faster for multi-MB S3 payloads on the CLI float) and falls back to `atob`/`btoa` elsewhere. The global is accessed through `globalThis` with a local structural type so the package keeps building without `@types/node`. The package must never _require_ a DOM- or Node-only API.
- `SecretsPipeline.unmaskHeaders` mutates its input parameter in place — matches `SecretProxyManager`'s legacy semantics so existing CLI callers compile unchanged.
- Build: `npm run build -w @slicc/shared-ts` (must run before `@slicc/node-server` build in the chain — wired into root `build` script).
- LSP/IDE: uses `tsconfig.json` (noEmit, includes src + tests). Build uses `tsconfig.build.json` (rootDir=src, emits to dist).

## Cross-implementation parity

The Swift counterpart of `SecretsPipeline` lives in `packages/swift-server/Sources/Keychain/SecretInjector.swift` (the class is named `SecretInjector` for historical reasons; it owns the same Basic-auth / URL-creds / byte-safe helpers and the OAuth replica chain). Both implementations are pinned to identical mask outputs via `packages/swift-server/Tests/CrossImplementationTests.swift` and `packages/shared-ts/tests/cross-impl-vectors.test.ts`.

## Naming

The `-ts` suffix is intentional: this package is the TypeScript half of the shared primitives. The Swift half currently lives inside `packages/swift-server/` for build-system convenience; if/when it's promoted to a standalone SPM package consumable from both `swift-server` and `swift-launcher`, the natural home is `packages/shared-swift/` so the two halves sit side-by-side in the file tree.
