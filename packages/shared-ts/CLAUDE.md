# @slicc/shared-ts

Platform-agnostic primitives shared across `@slicc/webapp`, `@slicc/node-server`, `@slicc/chrome-extension`.

## Contents

### Secrets & proxy

- `secret-masking.ts` — HMAC-SHA256 masking, domain matching, scrubbing. `secretScopeHostname(url)` is THE name a domain list matches against (hostname: no port, lowercase, punycode); all floats derive it.
- `secrets-pipeline.ts` — stateful unmask/scrub class; Basic-auth- + URL-credential-aware, byte-safe body unmask. `unmaskHeaders` mutates in place (`SecretProxyManager`).
- `content-type.ts` — fetch-proxy body classifiers. `isTextContentType` gates response scrub + body caching; `isTextRequestContentType`/`isFormContentType` gate request-body unmask ONLY (form POSTs carry secrets that must reach upstream unmasked). Swift twin `packages/swift-server/Sources/Server/ContentType.swift`; divergence leaks secrets. Pinned by `tests/content-type-parity.test.ts` + Swift tests.
- `form-body-unmask.ts` — `unmaskFormBody`: encoding-aware masked→real unmask for `application/x-www-form-urlencoded`. Unmasks each field's DECODED value, re-encodes only changed ones (a raw splice corrupts the form when a secret carries reserved `&`/`=`/`+`). Swift mirror `packages/swift-server/Sources/Server/FormBodyUnmask.swift`, pinned in both cross-impl tests.
- `secret-env-schema.ts` — `NAME=value` / `NAME_DOMAINS=csv` value-preserving parsers, pairing walk, S3-profile validation.
- `oauth-extra-domains-storage.ts` — pure-JS read/write over the `slicc_oauth_extra_domains` localStorage key; shares the per-provider store between extension `secrets.html` + webapp `provider-settings.ts`.
- `sigv4.ts` — pure SigV4 signer over Web Crypto, no AWS SDK; verified vs AWS vectors in `tests/sigv4.test.ts`.
- `sign-and-forward.ts` — S3 / Adobe da.live orchestration (`executeS3SignAndForward` / `executeDaSignAndForward`): validate envelope, resolve credentials via async `SecretGetter`, sign (S3) or attach Bearer (DA), forward, return a cloneable reply. webapp + node-server + extension SW.
- `raw-fetch-protocol.ts` — raw-mode fetch-proxy contract for the wasm realm's HTTP proxy: request-head JSON (`X-Slicc-Raw-Request`), probe (`X-Slicc-Raw-Probe`, `parseRawFetchProbeReply`), length-prefixed response-head frame, hop-by-hop stripping, drop `Content-Encoding`/`Content-Length` once decoded. node-server `routes/fetch-proxy-raw.ts` + webapp `shell/proxied-fetch-raw.ts`; Swift port `packages/swift-server/Sources/Server/RawFetchProtocol.swift`, pinned by `tests/cross-impl-vectors.test.ts`.
- `raw-fetch-upload.ts` — streamed raw uploads for extension SW + webapp bridge hop: `rawUploadStreams` (stream non-text bodies ≥8 MiB or unknown length; buffer text + HMAC-signed) and `withUnsentUploadRetry` (retry once when Chrome refused before the body produced a byte — e.g. first streamed request of a fresh connection).
- `proxy-headers.ts` — pure forbidden-header (Cookie/Origin/Referer/Proxy-\*, Set-Cookie) encode/decode for `/api/fetch-proxy`. Webapp shell fetch proxy + extension SW backend.

### Tray / sync wire contracts

- `tray-signaling.ts` — tray signaling contract (leader↔worker control messages, follower HTTP bootstrap shapes, retry constants, `successorVersionFromLinkHeader`); source of truth for webapp + cloudflare-worker. iOS follower mirrors a subset in `packages/swift-trayfollower/Sources/SliccTrayFollower/Models/TrayTypes.swift`. Worker-only state (`TrayBootstrapRecord`, `TrayRecord`) in `packages/cloudflare-worker/src/shared.ts`.
- `agent-wire-types.ts` — agent/chat payload types (`AgentEvent`, `ChatMessage`, `ToolCall`, `MessageAttachment`, `LickEvent`) embedded in the tray sync protocol. Types only; logic in webapp.
- `tray-sync-protocol.ts` — tray sync data-channel contract (`LeaderToFollowerMessage` / `FollowerToLeaderMessage` unions, summary/target/FS types, `TRAY_SYNC_PROTOCOL_VERSION`, `unhandledProtocolMessage`). Mirrored by `packages/swift-trayfollower/Sources/SliccTrayFollower/Models/SyncProtocol.swift`, enforced by corpus `packages/webapp/src/scoops/tray-sync-protocol-corpus.ts`. `TraySyncChannel` runtime webapp-side. Also:
  - CDP response chunking (`sendCDPResponse`, `reassembleCDPResponse`, `CDP_CHUNK_THRESHOLD`) over `cdp.response`.
  - Transport chunk frame (`TrayChunkFrame`, `TRAY_CHUNK_FRAME_TYPE`, `isTrayChunkFrame`) + bounds (`TRAY_DEFAULT_MAX_MESSAGE_BYTES`, `TRAY_MAX_MESSAGE_BYTES`, `TRAY_SEND_HIGH_WATER_BYTES`). Sits **below** the unions (senders split oversize, receivers reassemble before decode), so no fixture. Mirrored by `packages/slicc-cli/internal/protocol` `ChunkFrame` + `packages/swift-trayfollower/Sources/SliccTrayFollower/Models/TrayChunkFraming.swift`.
- `tray-url-shared.ts` — tray URL grammar: `parseTrayJoinUrl`, `normalizeTrayWorkerBaseUrl`, `buildCanonicalTrayLaunchUrl`, and `tray` / `trayWorkerUrl` / `lead` params. Pure `URL` helpers, so webapp leader (`base/tray-url-config.ts`) and node-server CLI float (`launch-url.ts`) parse join URLs the same.

### Bridge / launch / discovery

- `bridge-protocol.ts` — standalone/Electron thin-bridge launch contract: `slicc.bridge.v1.` subprotocol prefix, `bridge`/`bridgeToken` params, `X-Bridge-Token` header, and the **single source of truth** for hosted origins (`SLICC_HOSTED_ORIGIN`, `SLICC_STAGING_HUB_ORIGIN`); `lint:hosted-origin` blocks literals. Swift mirror `packages/swift-server/Sources/Server/BridgeSecurity.swift`.
- `loopback.ts` — canonical `isLoopbackHostname` / `isLoopbackOrigin` (localhost, `127.0.0.0/8`, bracketed/bare `::1`). Used by bridge-token exemption, localhost-only Express gates, shell-plugin `http:` allowlists, OAuth.
- `byte-range.ts` — `parseByteRange`: the single `Range: bytes=…` parser for every preview path (webapp `/preview/*` SW, tray leader live `serve`, worker old-leader fallback + `--ttl` snapshots). Returns inclusive window, `'unsatisfiable'` (416), or `null`. node-server `hostfs.ts` has its own.
- `slugify.ts` — parameterized display-name → ASCII slug (NFKD, `^-+|-+$` trim, optional `maxLen`/`fallback`). Consolidates copies.
- `backoff.ts` — `nextBackoffDelayMs({ attempt, baseMs, capMs?, jitter?, maxShift?, random? })`: the single capped-exponential-backoff formula (`Math.min(baseMs * 2 ** attempt, capMs)` + optional jitter/exponent clamp). Consolidates the copies that drifted across the three floats + webapp internals (#3926); each site passes its own base/cap.
- `sha256.ts` — `bytesToHex` + `sha256Hex` (offset views compacted via `byteOffset`/`byteLength` before `crypto.subtle.digest`).
- `extension-bridge-protocol.ts` — sliccy.ai leader tab ↔ extension SW `chrome.runtime.connect` envelope contract (handshake, CDP pass-through, licks, leader join-url, open-settings). chrome-extension imports it; webapp re-exports a shim.
- `extension-message.ts` — `isExtensionMessage` guard for the `{ source, payload }` page ↔ SW envelope. The full `ExtensionMessage` union stays in webapp `kernel/messages.ts` (type-only import); the guard is shared by extension + tests.
- `leader-ext-id.ts` — `LEADER_EXT_ID_QUERY_NAME` alone, split out of `extension-bridge-protocol.ts` so first-load webapp pages import just the constant.
- `link-header.ts` — pure RFC 8288 `Link` parser/builder + CDP/webRequest/Headers adapters. Dep of `discovery-link.ts` / `handoff-link.ts`; re-exported from webapp `net/discover-links.ts`.
- `discovery-link.ts` — ARD `ai-catalog` `Link`-rel extractor + `discoveryFingerprint`.
- `well-known-probe.ts` — `/.well-known/ai-catalog.json` / `/llms.txt` probe (credential-free, no redirects).
- `handoff-link.ts` — SLICC `handoff`/`upskill` `Link`-rel extractor, with shell-injection allowlists (`isSafeUpskillBranch`/`isSafeUpskillPath`) for values passed to the cone as `upskill` args.
- `github-releases.ts` — bounded newest→oldest GitHub releases scan (`scanGithubReleases`) + `GithubRelease` types. `per_page=100` × 5-page cap (500 backstop) shared by worker DMG/CLI routes + node-server `--install-cli`. Callers supply predicate + failure policy.
- `cdp-target-info.ts` — `TargetInfo` (`Target.getTargets` shape), the one export from webapp `cdp/types.ts` the extension needs.
- `iframe-repaint.ts` — Chromium nested-iframe first-paint workaround (`nudgeIframeRepaint`, `isNestedInAnotherFrame`); webapp `ui/sprinkle-renderer.ts` + extension `sidepanel-entry.ts`. `tsconfig.json` includes `DOM`.

### Transcript

- `transcript-export.ts` — `TranscriptDocumentV1` types, `TranscriptExportError`, `validateTranscriptDocumentV1()`. Shared by webapp export-service, cherry, bundle validators. Format + privacy: [`docs/transcript-export.md`](../../docs/transcript-export.md).
- `transcript-redaction.ts` — `applyRedactions()` + credential-pattern detector. Runs before ZIP assembly; fail-closed (`TranscriptExportError('redaction-unavailable')`).

## Conventions

- Prefer universal globals (`crypto.subtle`, `TextEncoder`, `Headers`, `atob`/`btoa`) so one build runs unchanged in browser, extension SW, Node 22+. Platform fast-paths only when feature-detected with a fallback (e.g. `sign-and-forward.ts` reaches `Buffer` via `globalThis`). Never _require_ a DOM- or Node-only API.
- `-ts` suffix marks the TS half of a cross-impl pair; the Swift half lives in `packages/swift-server/`.
- Build: `npm run build -w @slicc/shared-ts` (must precede `@slicc/node-server`; wired into root `build`). IDE uses `tsconfig.json` (noEmit, src + tests); build uses `tsconfig.build.json` (src → dist).

## Cross-implementation parity

`SecretsPipeline`'s Swift counterpart is `packages/swift-server/Sources/Keychain/SecretInjector.swift` (historic name; same helpers + OAuth replica chain), pinned to identical mask outputs via `packages/swift-server/Tests/CrossImplementationTests.swift` + `tests/cross-impl-vectors.test.ts`. See also the `content-type.ts` / `form-body-unmask.ts` twins.
