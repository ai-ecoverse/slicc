# @slicc/shared-ts

Platform-agnostic primitives shared across `@slicc/webapp`, `@slicc/node-server`, `@slicc/chrome-extension`.

## Contents

### Secrets & proxy

- `secret-masking.ts` — HMAC-SHA256 masking, domain matching, scrubbing.
- `secrets-pipeline.ts` — stateful unmask/scrub class; Basic-auth-, URL-credential-aware, byte-safe body unmask. `unmaskHeaders` mutates input in place (legacy `SecretProxyManager` semantics).
- `content-type.ts` — fetch-proxy body classifiers. `isTextContentType` gates response scrub + body caching; `isTextRequestContentType`/`isFormContentType` gate request-body unmask ONLY (form POSTs like OAuth token exchange carry secrets that must reach upstream unmasked). Swift twin `packages/swift-server/Sources/Server/ContentType.swift` — divergence is a secret leak; both pinned by `tests/content-type-parity.test.ts` and `CrossImplementationTests.swift`; change together only.
- `form-body-unmask.ts` — `unmaskFormBody`: encoding-aware masked→real unmask for `application/x-www-form-urlencoded` bodies. Unmasks each field's DECODED value and re-encodes only changed values (a substring splice corrupts a form when the real secret carries a reserved `&`/`=`/`+`). Swift mirror `packages/swift-server/Sources/Server/FormBodyUnmask.swift`, pinned in both cross-impl test files.
- `secret-env-schema.ts` — canonical `NAME=value` / `NAME_DOMAINS=csv` value-preserving parsers, pairing walk, S3 profile validation for secret-storage consumers.
- `oauth-extra-domains-storage.ts` — pure-JS read/write over the `slicc_oauth_extra_domains` localStorage key; shares the per-provider store between the extension options page (`secrets.html`) and webapp `provider-settings.ts`.
- `sigv4.ts` — pure SigV4 request signer over Web Crypto (`crypto.subtle`), no AWS SDK; verified against canonical AWS vectors in `tests/sigv4.test.ts`.
- `sign-and-forward.ts` — S3 / Adobe da.live orchestration (`executeS3SignAndForward` / `executeDaSignAndForward`): validates an envelope, resolves credentials via async `SecretGetter`, signs (S3) or attaches a Bearer token (DA), forwards, returns a JSON-cloneable reply. Used by webapp mount barrel, node-server handlers, and the extension SW.
- `proxy-headers.ts` — pure forbidden-header (Cookie/Origin/Referer/Proxy-\*, Set-Cookie) encode/decode helpers for `/api/fetch-proxy`. Shared by the webapp shell fetch proxy and extension SW backend.

### Tray / sync wire contracts

- `tray-signaling.ts` — tray signaling wire contract (leader↔worker control messages, follower HTTP bootstrap shapes, retry constants, `successorVersionFromLinkHeader`). Single source of truth for webapp and cloudflare-worker; iOS follower mirrors a subset in `packages/swift-trayfollower/Sources/SliccTrayFollower/Models/TrayTypes.swift`. Worker-internal persisted state (`TrayBootstrapRecord`, `TrayRecord`) is in `packages/cloudflare-worker/src/shared.ts`.
- `agent-wire-types.ts` — agent/chat wire payload types (`AgentEvent`, `ChatMessage`, `ToolCall`, `MessageAttachment`, `LickEvent`) embedded in the tray sync protocol. Types only; produce/consume behavior stays in webapp.
- `tray-sync-protocol.ts` — tray sync data-channel wire contract (`LeaderToFollowerMessage` / `FollowerToLeaderMessage` unions, summary/target/FS types, `TRAY_SYNC_PROTOCOL_VERSION`, `unhandledProtocolMessage`). Partially mirrored by `packages/swift-trayfollower/Sources/SliccTrayFollower/Models/SyncProtocol.swift`, enforced by golden-fixture corpus `packages/webapp/src/scoops/tray-sync-protocol-corpus.ts`. `TraySyncChannel` runtime is webapp-side. Also holds:
  - CDP response chunking helpers (`sendCDPResponse`, `reassembleCDPResponse`, `CDP_CHUNK_THRESHOLD`) over the `cdp.response` variant.
  - Transport chunk frame (`TrayChunkFrame`, `TRAY_CHUNK_FRAME_TYPE`, `isTrayChunkFrame`) + bounds (`TRAY_DEFAULT_MAX_MESSAGE_BYTES`, `TRAY_MAX_MESSAGE_BYTES`, `TRAY_SEND_HIGH_WATER_BYTES`). A frame sits **below** the message unions (senders split oversize messages; receivers reassemble before decoding), so it has no corpus fixture. Mirrored by `packages/slicc-cli/internal/protocol` (`ChunkFrame`) and `packages/swift-trayfollower/Sources/SliccTrayFollower/Models/TrayChunkFraming.swift`.
- `tray-url-shared.ts` — tray URL grammar: `parseTrayJoinUrl`, `normalizeTrayWorkerBaseUrl`, `buildCanonicalTrayLaunchUrl`, and the `tray` / `trayWorkerUrl` / `lead` query-param names. Pure `URL` string helpers, so the browser leader (webapp `base/tray-url-config.ts`, re-exports) and Node CLI float (node-server `launch-url.ts`) parse join URLs identically. Lives here so the browser-first webapp never reaches into Node.

### Bridge / launch / discovery

- `bridge-protocol.ts` — standalone/Electron thin-bridge launch contract: `slicc.bridge.v1.` subprotocol prefix, `bridge`/`bridgeToken` query params, `X-Bridge-Token` header, and the **single source of truth** for hosted origins (`SLICC_HOSTED_ORIGIN`, `SLICC_STAGING_HUB_ORIGIN`) every TS package imports rather than hardcode (`lint:hosted-origin` blocks raw literals). Swift mirror: `packages/swift-server/Sources/Server/BridgeSecurity.swift`.
- `loopback.ts` — canonical `isLoopbackHostname` / `isLoopbackOrigin` (localhost, `127.0.0.0/8`, bracketed/bare `::1`). Used by bridge-token exemption, localhost-only Express gates, shell-plugin `http:` allowlists, OAuth redirect branching — don't reimplement.
- `byte-range.ts` — `parseByteRange`: the single `Range: bytes=…` parser for every preview path (webapp `/preview/*` SW, tray leader live `serve`, worker old-leader fallback and `--ttl` snapshots). Returns an inclusive window, `'unsatisfiable'` (416), or `null` (serve the whole entity). node-server `hostfs.ts` keeps its own tagged-union variant.
- `slugify.ts` — parameterized display-name → ASCII slug (NFKD, `^-+|-+$` hyphen trim, optional `maxLen`/`fallback`). Consolidates drifted webapp copies; don't reimplement.
- `extension-bridge-protocol.ts` — sliccy.ai leader tab ↔ extension SW `chrome.runtime.connect` envelope contract (handshake, CDP pass-through, licks, leader join-url, open-settings). chrome-extension imports directly; webapp re-exports a shim.
- `extension-message.ts` — `isExtensionMessage` runtime guard for the `{ source, payload }` page ↔ SW envelope. The full `ExtensionMessage` union stays in webapp `kernel/messages.ts` (type-only import allowed); this guard is the value the thin extension and its tests share.
- `leader-ext-id.ts` — `LEADER_EXT_ID_QUERY_NAME` alone, split out of `extension-bridge-protocol.ts` so two first-load webapp pages import just this constant without widening the eager page graph (`package.json` `"sideEffects": false` lets bundlers tree-shake the barrel).
- `link-header.ts` — pure RFC 8288 `Link` parser/builder (no I/O) + CDP/webRequest/Headers adapters. Transitive dep of `discovery-link.ts` / `handoff-link.ts`; re-exported from webapp for `net/discover-links.ts`.
- `discovery-link.ts` — ARD `ai-catalog` `Link`-rel extractor, `discoveryFingerprint`.
- `well-known-probe.ts` — `/.well-known/ai-catalog.json` / `/llms.txt` probe (credential-free, non-redirect-following SSO guard).
- `handoff-link.ts` — SLICC `handoff`/`upskill` `Link`-rel extractor, with shell-injection-defense allowlists (`isSafeUpskillBranch`/`isSafeUpskillPath`) for values riding to the cone as `upskill` args.
- `github-releases.ts` — bounded newest→oldest GitHub releases scan (`scanGithubReleases`) + `GithubRelease` types. `per_page=100` × 5-page cap (500-release backstop) shared by worker DMG/CLI download routes and node-server `--install-cli`. Callers supply the asset predicate and failure policy.
- `cdp-target-info.ts` — `TargetInfo` (`Target.getTargets` result shape), the one export from webapp `cdp/types.ts` the extension needs.
- `iframe-repaint.ts` — Chromium nested-iframe first-paint workaround (`nudgeIframeRepaint`, `isNestedInAnotherFrame`); needed by webapp `ui/sprinkle-renderer.ts` and extension `sidepanel-entry.ts`. `tsconfig.json` includes the `DOM` lib.

### Transcript

- `transcript-export.ts` — `TranscriptDocumentV1` schema types, `TranscriptExportError`, `validateTranscriptDocumentV1()`. Shared by `@slicc/webapp` (export-service), `@ai-ecoverse/cherry`, bundle validators. Format + privacy: [`docs/transcript-export.md`](../../docs/transcript-export.md).
- `transcript-redaction.ts` — `applyRedactions()` + credential-pattern detector. Runs unconditionally before ZIP assembly; fail-closed (throws `TranscriptExportError('redaction-unavailable')`).

## Conventions

- Prefer universal globals (`crypto.subtle`, `TextEncoder`, `Headers`, `atob`/`btoa`) so one build runs unchanged in the browser, extension SW, and Node 22+ server. A platform-specific fast-path is allowed only when feature-detected with a fallback — e.g. `sign-and-forward.ts` reaches Node's `Buffer` via `globalThis` behind a runtime check (faster for multi-MB S3 payloads; a local structural type keeps the build free of `@types/node`), else `atob`/`btoa`. Never _require_ a DOM- or Node-only API.
- `-ts` suffix marks the TypeScript half of a cross-impl pair; the Swift half lives in `packages/swift-server/` for build convenience.
- Build: `npm run build -w @slicc/shared-ts` (must precede the `@slicc/node-server` build — wired into root `build`). IDE uses `tsconfig.json` (noEmit, src + tests); the build uses `tsconfig.build.json` (rootDir=src → dist).

## Cross-implementation parity

The Swift counterpart of `SecretsPipeline` is `packages/swift-server/Sources/Keychain/SecretInjector.swift` (historic name; same helpers and OAuth replica chain), pinned to identical mask outputs via `packages/swift-server/Tests/CrossImplementationTests.swift` and `tests/cross-impl-vectors.test.ts`. See also the `content-type.ts` / `form-body-unmask.ts` twins.
