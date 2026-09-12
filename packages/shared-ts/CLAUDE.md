# @slicc/shared-ts

Platform-agnostic primitives shared across `@slicc/webapp`, `@slicc/node-server`, and `@slicc/chrome-extension`.

## Contents

### Secrets & proxy

- `secret-masking.ts` — HMAC-SHA256 masking, domain matching, scrubbing.
- `secrets-pipeline.ts` — stateful unmask/scrub class; Basic-auth-aware, URL-credential-aware, byte-safe body unmask. `unmaskHeaders` mutates input in place (matches `SecretProxyManager`'s legacy semantics so CLI callers compile unchanged).
- `content-type.ts` — fetch-proxy body classifiers. `isTextContentType` gates response scrub + body caching; `isTextRequestContentType`/`isFormContentType` gate request-body unmask ONLY (form POSTs like OAuth token exchange carry secrets that must reach upstream unmasked). Swift twin `packages/swift-server/Sources/Server/ContentType.swift` — divergence is a secret leak, so both are pinned by `tests/content-type-parity.test.ts` and `CrossImplementationTests.swift`; change together only.
- `form-body-unmask.ts` — `unmaskFormBody`: encoding-aware masked→real unmask for `application/x-www-form-urlencoded` bodies. A substring splice corrupts a form when the real secret carries a reserved char (`&`/`=`/`+`, common in base64), so it unmasks each field's DECODED value and re-encodes only changed values. Swift mirror `packages/swift-server/Sources/Server/FormBodyUnmask.swift`, pinned in both cross-impl test files.
- `secret-env-schema.ts` — canonical `NAME=value` / `NAME_DOMAINS=csv` value-preserving parsers, pairing walk, S3 profile validation for secret-storage consumers.
- `oauth-extra-domains-storage.ts` — pure-JS read/write over the `slicc_oauth_extra_domains` localStorage key, sharing the per-provider extra-domains store between the extension options page (`secrets.html`) and webapp's `provider-settings.ts`.
- `sigv4.ts` — pure SigV4 v4 request signer over Web Crypto (`crypto.subtle`), no AWS SDK. Verified against canonical AWS vectors in `tests/sigv4.test.ts`.
- `sign-and-forward.ts` — S3 / Adobe da.live sign-and-forward orchestration (`executeS3SignAndForward` / `executeDaSignAndForward`): validates an envelope, resolves credentials via async `SecretGetter`, signs (S3) or attaches a Bearer token (DA), forwards, returns a JSON-cloneable reply. Used by the webapp mount barrel, node-server handlers (`SecretStore` adapter), and the extension SW.
- `proxy-headers.ts` — pure forbidden-header (Cookie/Origin/Referer/Proxy-\*, Set-Cookie) encode/decode helpers for `/api/fetch-proxy`. Shared by the webapp shell fetch proxy and the extension SW backend.

### Tray / sync wire contracts

- `tray-signaling.ts` — tray signaling wire contract (leader↔worker control messages, follower HTTP bootstrap shapes, retry constants, `successorVersionFromLinkHeader`). Single source of truth for webapp and cloudflare-worker; iOS follower mirrors a subset in `packages/swift-trayfollower/Sources/SliccTrayFollower/Models/TrayTypes.swift`. Worker-internal persisted state (`TrayBootstrapRecord`, `TrayRecord`) lives in `packages/cloudflare-worker/src/shared.ts`.
- `agent-wire-types.ts` — agent/chat wire payload types (`AgentEvent`, `ChatMessage`, `ToolCall`, `MessageAttachment`, `LickEvent`) embedded in the tray sync protocol. Types only; producing/consuming behavior stays in webapp, which re-exports them from layer-local modules.
- `tray-sync-protocol.ts` — tray sync data-channel wire contract (`LeaderToFollowerMessage` / `FollowerToLeaderMessage` unions, summary/target/FS types, `TRAY_SYNC_PROTOCOL_VERSION`, `unhandledProtocolMessage`). Partially mirrored by `packages/swift-trayfollower/Sources/SliccTrayFollower/Models/SyncProtocol.swift`, enforced by the golden-fixture corpus `packages/webapp/src/scoops/tray-sync-protocol-corpus.ts`. The `TraySyncChannel` runtime is webapp-side. Also:
  - CDP response chunking helpers (`sendCDPResponse`, `reassembleCDPResponse`, `CDP_CHUNK_THRESHOLD`) — pure over the `cdp.response` variant, so they sit next to the wire union, not in webapp `scoops/`.
  - The transport chunk frame (`TrayChunkFrame`, `TRAY_CHUNK_FRAME_TYPE`, `isTrayChunkFrame`) + bounds (`TRAY_DEFAULT_MAX_MESSAGE_BYTES`, `TRAY_MAX_MESSAGE_BYTES`, `TRAY_SEND_HIGH_WATER_BYTES`). A frame sits **below** the message unions (senders split oversize messages into frames; receivers reassemble before decoding) so it has no corpus fixture. Mirrored by `packages/slicc-cli/internal/protocol` (`ChunkFrame`) and `packages/swift-trayfollower/Sources/SliccTrayFollower/Models/TrayChunkFraming.swift`.
- `tray-url-shared.ts` — the tray URL grammar: `parseTrayJoinUrl`, `normalizeTrayWorkerBaseUrl`, `buildCanonicalTrayLaunchUrl`, and the `tray` / `trayWorkerUrl` / `lead` query-param names. Pure `URL` string helpers, so the browser leader (webapp `base/tray-url-config.ts`, re-exports) and the Node CLI float (node-server `launch-url.ts`) parse join URLs identically. Lives here, not node-server, so the browser-first webapp never reaches into Node.

### Bridge / launch / discovery

- `bridge-protocol.ts` — standalone/Electron thin-bridge launch contract: `slicc.bridge.v1.` subprotocol prefix, `bridge`/`bridgeToken` query params, `X-Bridge-Token` header, and the **single source of truth** for the hosted origins (`SLICC_HOSTED_ORIGIN`, `SLICC_STAGING_HUB_ORIGIN`) every TS package imports rather than hardcode — `lint:hosted-origin` blocks raw literals. Swift mirror: `packages/swift-server/Sources/Server/BridgeSecurity.swift`.
- `loopback.ts` — canonical `isLoopbackHostname` / `isLoopbackOrigin` (localhost, `127.0.0.0/8`, bracketed/bare `::1`). Used by bridge-token exemption, localhost-only Express gates, shell-plugin `http:` allowlists, OAuth redirect branching — don't reimplement.
- `slugify.ts` — parameterized display-name → ASCII slug (NFKD, `^-+|-+$` hyphen trim, optional `maxLen`/`fallback`). Consolidates the previously drifted webapp copies — don't reimplement.
- `extension-bridge-protocol.ts` — the sliccy.ai leader tab ↔ extension SW `chrome.runtime.connect` envelope contract (handshake, CDP pass-through, licks, leader join-url, open-settings). chrome-extension imports it directly; webapp re-exports a shim.
- `extension-message.ts` — `isExtensionMessage` runtime guard for the `{ source, payload }` page ↔ SW envelope. The full `ExtensionMessage` union stays in webapp `kernel/messages.ts` (type-only import allowed); this guard is the value the thin extension and its tests share without climbing into `packages/webapp/src` (#3047).
- `leader-ext-id.ts` — `LEADER_EXT_ID_QUERY_NAME` alone, split out of `extension-bridge-protocol.ts` so two first-load webapp pages import just this constant without widening the eager page graph. `package.json` sets `"sideEffects": false` (all top-level code is pure value construction) so bundlers tree-shake the barrel.
- `link-header.ts` — pure RFC 8288 `Link` parser/builder (no I/O), plus CDP/webRequest/Headers adapters. Transitive dependency of `discovery-link.ts` / `handoff-link.ts`; re-exported from webapp for `net/discover-links.ts`.
- `discovery-link.ts` — ARD `ai-catalog` `Link`-rel extractor, `discoveryFingerprint`.
- `well-known-probe.ts` — `/.well-known/ai-catalog.json` / `/llms.txt` probe (credential-free, non-redirect-following — SSO-hijack guard).
- `handoff-link.ts` — SLICC `handoff`/`upskill` `Link`-rel extractor, with shell-injection-defense allowlists (`isSafeUpskillBranch`/`isSafeUpskillPath`) for values riding to the cone as `upskill` args.
- `github-releases.ts` — bounded newest→oldest GitHub releases scan (`scanGithubReleases`) plus `GithubRelease` types. One `per_page=100` × 5-page cap (GitHub's max page size; 500-release backstop) shared by the worker DMG/CLI download routes and node-server `--install-cli`. Callers supply the asset predicate and failure policy. Go/Swift twins of the walk are out of scope.
- `cdp-target-info.ts` — `TargetInfo` (`Target.getTargets` result shape), the one export from webapp's `cdp/types.ts` the extension needs; the rest stays internal.
- `iframe-repaint.ts` — Chromium nested-iframe first-paint workaround (`nudgeIframeRepaint`, `isNestedInAnotherFrame`); needed by both webapp's `ui/sprinkle-renderer.ts` and the extension's `sidepanel-entry.ts`. `tsconfig.json` includes the `DOM` lib.

### Transcript

- `transcript-export.ts` — `TranscriptDocumentV1` schema types, `TranscriptExportError`, `validateTranscriptDocumentV1()`. Shared by `@slicc/webapp` (export-service), `@ai-ecoverse/cherry` (protocol error type), and bundle validators. Format + privacy: [`docs/transcript-export.md`](../../docs/transcript-export.md).
- `transcript-redaction.ts` — `applyRedactions()` + the credential-pattern detector. Runs unconditionally before ZIP assembly; fail-closed (throws `TranscriptExportError('redaction-unavailable')` if init fails).

## Conventions

- Prefer universal globals (`crypto.subtle`, `TextEncoder`, `Headers`, `atob`/`btoa`) so one build runs unchanged in the browser, extension SW, and Node 22+ server. A platform-specific fast-path is allowed only when feature-detected with a fallback — e.g. `sign-and-forward.ts` reaches Node's `Buffer` via `globalThis` behind a runtime check (faster for multi-MB S3 payloads; a local structural type keeps the build free of `@types/node`), else `atob`/`btoa`. Never _require_ a DOM- or Node-only API.
- Build: `npm run build -w @slicc/shared-ts` (must precede the `@slicc/node-server` build — wired into root `build`). LSP/IDE uses `tsconfig.json` (noEmit, src + tests); the build uses `tsconfig.build.json` (rootDir=src → dist).

## Cross-implementation parity

The Swift counterpart of `SecretsPipeline` is `packages/swift-server/Sources/Keychain/SecretInjector.swift` (named `SecretInjector` historically; same Basic-auth / URL-creds / byte-safe helpers and OAuth replica chain), pinned to identical mask outputs via `packages/swift-server/Tests/CrossImplementationTests.swift` and `packages/shared-ts/tests/cross-impl-vectors.test.ts`. See also the `content-type.ts` / `form-body-unmask.ts` twins.

The `-ts` suffix marks the TypeScript half; the Swift half lives inside `packages/swift-server/` for build convenience (natural home if promoted to a standalone SPM package: `packages/shared-swift/`).
