# @slicc/shared-ts

Platform-agnostic primitives shared across `@slicc/webapp`, `@slicc/node-server`, and the Chrome extension in [ai-ecoverse/slicc-extension](https://github.com/ai-ecoverse/slicc-extension) (which carries its own copy). A change to an extension-facing module (bridge, fetch-proxy, secrets, sign-and-forward, extension-message) must also land there.

## Contents

### Secrets & proxy

- `secret-masking.ts` — HMAC-SHA256 masking, domain match, scrub. `secretScopeHostname(url)` is THE name (no port, lowercase, punycode) a domain list matches against; all floats derive it.
- `secrets-pipeline.ts` — stateful unmask/scrub class (`SecretProxyManager`); Basic-auth- + URL-credential-aware byte-safe body unmask; `unmaskHeaders` mutates in place.
- `content-type.ts` — fetch-proxy body classifiers. `isTextContentType` gates response scrub + body caching; `isTextRequestContentType`/`isFormContentType` gate request-body unmask ONLY (form POSTs carry secrets that reach upstream raw). Swift twin `packages/swift-server/Sources/Server/ContentType.swift` — divergence leaks secrets; pinned by `tests/content-type-parity.test.ts`.
- `form-body-unmask.ts` — `unmaskFormBody`: encoding-aware masked→real unmask for `application/x-www-form-urlencoded`. Unmasks each field's DECODED value, re-encodes only changed ones (a raw splice corrupts the form when a secret carries reserved `&`/`=`/`+`). Swift `packages/swift-server/Sources/Server/FormBodyUnmask.swift`, pinned both ways.
- `secret-env-schema.ts` — `NAME=value` / `NAME_DOMAINS=csv` value-preserving parsers, pairing walk, S3-profile check.
- `oauth-extra-domains-storage.ts` — `slicc_oauth_extra_domains` localStorage per-provider store; extension `secrets.html` + webapp `provider-settings.ts`.
- `storage-quarantine.ts` — `replaceStoredValue`: whole-store localStorage write that first copies an unparsable value to `<key>.corrupt`; the original stays on `<key>` until the copy is stored, else it throws and saves nothing. `oauth-extra-domains-storage.ts` + webapp `base/stored-accounts.ts` (#4146).
- `sigv4.ts` — Web Crypto SigV4 signer (no AWS SDK); AWS vectors in `tests/sigv4.test.ts`.
- `sign-and-forward.ts` — S3 / da.live (`executeS3SignAndForward` / `executeDaSignAndForward`): validate envelope, resolve creds via async `SecretGetter`, sign (S3) or Bearer (DA), forward, cloneable reply. Webapp/node-server/ext SW.
- `raw-fetch-protocol.ts` — raw-mode fetch-proxy contract for the wasm realm proxy: request-head JSON (`X-Slicc-Raw-Request`), probe (`X-Slicc-Raw-Probe`, `parseRawFetchProbeReply`), length-prefixed response-head frame, hop-by-hop strip, drop `Content-Encoding`/`Content-Length` on decode. node-server `routes/fetch-proxy-raw.ts`, webapp `shell/proxied-fetch-raw.ts`; Swift `packages/swift-server/Sources/Server/RawFetchProtocol.swift`.
- `raw-fetch-upload.ts` — ext SW + webapp bridge raw uploads: `rawUploadStreams` (stream non-text ≥8 MiB/unknown length; buffer text and HMAC-signed bodies), `withUnsentUploadRetry` (retry once if Chrome refuses pre-body).
- `proxy-headers.ts` — forbidden-header (Cookie/Origin/Referer/Proxy-\*, Set-Cookie) encode/decode for `/api/fetch-proxy`. Webapp shell proxy + ext SW backend.

### Tray / sync wire contracts

- `tray-signaling.ts` — tray signaling contract (leader↔worker control messages, follower HTTP bootstrap shapes, retry constants, `successorVersionFromLinkHeader`); source of truth for webapp + worker. iOS follower mirrors a subset in `packages/swift-trayfollower/Sources/SliccTrayFollower/Models/TrayTypes.swift`; worker-only state (`TrayBootstrapRecord`, `TrayRecord`) in `packages/cloudflare-worker/src/shared.ts`.
- `agent-wire-types.ts` — agent/chat payload types (`AgentEvent`, `ChatMessage`, `ToolCall`, `MessageAttachment`, `LickEvent`) embedded in the tray sync protocol. Types only; logic in webapp.
- `tray-sync-protocol.ts` — tray sync data-channel contract (`LeaderToFollowerMessage` / `FollowerToLeaderMessage` unions, summary/target/FS types, `TRAY_SYNC_PROTOCOL_VERSION`, `unhandledProtocolMessage`). Mirrored by `packages/swift-trayfollower/Sources/SliccTrayFollower/Models/SyncProtocol.swift`, enforced by corpus `packages/webapp/src/scoops/tray-sync-protocol-corpus.ts`. `TraySyncChannel` runtime webapp-side. Also:
  - CDP response chunking (`sendCDPResponse`, `reassembleCDPResponse`, `CDP_CHUNK_THRESHOLD`) on `cdp.response`.
  - Transport chunk frame (`TrayChunkFrame`, `TRAY_CHUNK_FRAME_TYPE`, `isTrayChunkFrame`) + bounds (`TRAY_DEFAULT_MAX_MESSAGE_BYTES`, `TRAY_MAX_MESSAGE_BYTES`, `TRAY_SEND_HIGH_WATER_BYTES`). Sits **below** the unions (senders split oversize, receivers reassemble before decode), no fixture. Mirrored by `packages/slicc-cli/internal/protocol` `ChunkFrame` + swift-trayfollower `TrayChunkFraming`.
- `tray-url-shared.ts` — tray URL grammar: `parseTrayJoinUrl`, `normalizeTrayWorkerBaseUrl`, `buildCanonicalTrayLaunchUrl`, and `tray`/`trayWorkerUrl`/`lead` params. Pure `URL` helpers; webapp `base/tray-url-config.ts` + node-server `launch-url.ts` parse join URLs identically.

### Bridge / launch / discovery

- `bridge-protocol.ts` — standalone/Electron thin-bridge launch contract: `slicc.bridge.v1.` subprotocol prefix, `bridge`/`bridgeToken` params, `X-Bridge-Token` header, and **the single source of truth** for hosted origins (`SLICC_HOSTED_ORIGIN`, `SLICC_STAGING_HUB_ORIGIN`); `lint:hosted-origin` blocks literals. Swift mirror `packages/swift-server/Sources/Server/BridgeSecurity.swift`.
- `loopback.ts` — canonical `isLoopbackHostname` / `isLoopbackOrigin` (localhost, `127.0.0.0/8`, bracketed/bare `::1`). Bridge-token exemption, localhost Express gates, shell-plugin `http:` allowlists, OAuth.
- `byte-range.ts` — `parseByteRange`: the single `Range: bytes=…` parser for every preview path (webapp `/preview/*` SW, tray leader live `serve`, worker old-leader fallback + `--ttl` snapshots). Returns inclusive window, `'unsatisfiable'` (416), or `null`. node-server `hostfs.ts` has its own.
- `slugify.ts` — display-name → ASCII slug (NFKD, `^-+|-+$` trim, optional `maxLen`/`fallback`).
- `backoff.ts` — `nextBackoffDelayMs({ attempt, baseMs, capMs?, jitter?, maxShift?, random? })`: the single capped-exponential-backoff formula `Math.min(baseMs * 2 ** attempt, capMs)` + optional jitter/exponent clamp; each site supplies base/cap.
- `sha256.ts` — `bytesToHex` + `sha256Hex` (offset views compacted before digest).
- `extension-bridge-protocol.ts` — sliccy.ai leader tab ↔ ext SW `chrome.runtime.connect` envelope (handshake, CDP pass-through, licks, leader join-url, open-settings). slicc-extension mirrors it; webapp re-exports a shim.
- `extension-message.ts` — `isExtensionMessage` guard for the `{ source, payload }` page ↔ SW envelope. Full `ExtensionMessage` union stays in webapp `kernel/messages.ts` (type-only import); guard shared with extension.
- `leader-ext-id.ts` — `LEADER_EXT_ID_QUERY_NAME` alone, so first-load pages skip `extension-bridge-protocol.ts`.
- `link-header.ts` — RFC 8288 `Link` parser/builder + CDP/webRequest/Headers adapters. Dep of `discovery-link.ts` / `handoff-link.ts`; re-exported by webapp `net/discover-links.ts`.
- `discovery-link.ts` — ARD `ai-catalog` `Link`-rel extractor, `discoveryFingerprint`.
- `well-known-probe.ts` — `/.well-known/ai-catalog.json` / `/llms.txt` probe (no creds, no redirects).
- `handoff-link.ts` — SLICC `handoff`/`upskill` `Link`-rel extractor + injection allowlists (`isSafeUpskillBranch`/`isSafeUpskillPath`).
- `github-releases.ts` — bounded newest→oldest GitHub releases scan (`scanGithubReleases`) + `GithubRelease` types. `per_page=100` × 5 pages; worker DMG/CLI routes + node-server `--install-cli` pass predicate/policy.
- `cdp-target-info.ts` — `TargetInfo` (`Target.getTargets` shape), the one webapp `cdp/types.ts` export the extension needs.
- `iframe-repaint.ts` — Chromium nested-iframe first-paint workaround (`nudgeIframeRepaint`, `isNestedInAnotherFrame`); webapp `ui/sprinkle-renderer.ts` + extension `sidepanel-entry.ts`. `tsconfig.json` adds `DOM`.

### Transcript

- `transcript-export.ts` — `TranscriptDocumentV1` types, `TranscriptExportError`, `validateTranscriptDocumentV1()`. Shared by webapp export-service, cherry, bundle validators. Format/privacy: [`docs/transcript-export.md`](../../docs/transcript-export.md).
- `profile-export.ts` — `slicc-profile` (SLICC 6 → 7 export): v1 zip (`SliccProfileManifestV1`, `validateSliccProfileManifestV1()`) and v2 directory form, whose files stay in place under `/slicc-fs/` as `source` (`SliccProfileManifestV2`, `validateSliccProfileManifestV2()`, `isSafeProfileSourcePath()`); `validateSliccProfileManifest()` dispatches by `version`. Also `profileFlagRuleFor()` (credential-like files), archive limits. ai-ecoverse/slicc-agent `freezer import` keeps a copy + the fixture zip; change both ([`docs/profile-export.md`](../../docs/profile-export.md)).
- `transcript-redaction.ts` — `applyRedactions()` + credential-pattern detector. Runs before ZIP assembly, fail-closed (`TranscriptExportError('redaction-unavailable')`).

## Conventions

- Prefer universal globals (`crypto.subtle`, `TextEncoder`, `Headers`, `atob`/`btoa`) so one build runs unchanged in browser, extension SW, Node 22+. Platform fast-paths only when feature-detected with a fallback (`sign-and-forward.ts` gets `Buffer` via `globalThis`). Never _require_ a DOM/Node-only API.
- `-ts` suffix marks the TS half of a cross-impl pair; the Swift half lives in `packages/swift-server/`.
- Build: `npm run build -w @slicc/shared-ts` (must precede `@slicc/node-server`; wired into root `build`). IDE `tsconfig.json` (noEmit); build `tsconfig.build.json`.

## Cross-implementation parity

`SecretsPipeline`'s Swift counterpart is `packages/swift-server/Sources/Keychain/SecretInjector.swift` (historic name; same helpers + OAuth replica chain), pinned to identical mask outputs via `packages/swift-server/Tests/CrossImplementationTests.swift` + `tests/cross-impl-vectors.test.ts` — as are the `content-type.ts` / `form-body-unmask.ts` twins.
