/**
 * CapabilityBroker protocol (#2276, Phase 6 of #1666).
 *
 * Slice A shipped the protocol and one page stub. Slice B replaced the stubs
 * with real adapters keyed by float topology (`node-rest`, `extension-direct`,
 * `extension-delegate`, `connect`), composed once in `kernel/host.ts`. Slice C
 * removes float probes from `scoops/` / `tools/` / `kernel/` business logic
 * (review-patterns category 10), one domain per PR — network, secrets and
 * mounts are done.
 *
 * `network` (#2276 slice C, done, #2829): none of `scoops/tray-leader.ts`
 * (`createTrayFetch`), `shell/proxied-fetch.ts` (`createProxiedFetch`) or
 * `shell/mcp/redirect-uri.ts` (`resolveMcpRedirectUri`) is now `broker.network
 * .crossOriginFetch` — none of the three is a privileged operation behind an
 * allowlist, they are `SecureFetch`-shaped transport factories called from
 * 18+ `shell/` sites with no broker in scope, so `network.crossOriginFetch`
 * stays the broker op for a caller that DOES hold a broker (none migrated
 * yet, and none need to for this reason). What actually happened: `scoops/
 * tray-leader.ts` lost its only realm/topology read, period — `createTrayFetch`
 * (with its `TrayProxyFetchError`) moved to `shell/tray-fetch.ts`, a sibling
 * of `proxied-fetch.ts`, because deciding "raw fetch or `/api/fetch-proxy`"
 * is a transport-layer decision, not `scoops/` business logic; caching the
 * probe in place would have been the same probe under a new name, in the
 * same wrong layer. `shell/proxied-fetch.ts` and `shell/tray-fetch.ts` read
 * `getChromeExtensionRealm()` — `base/api-endpoint.ts`'s lazily-cached,
 * per-realm fact, mirroring its `extensionDelegateId` / `localApiBaseUrl`
 * idiom — because `shell/` is where topology is OWNED (see
 * `shell/float-topology.ts`'s header); that read is fine and expected there,
 * it is still a probe, and `scoops/` / `tools/` / `kernel/` (except `kernel/
 * host.ts`) must never call it either. `redirect-uri.ts`'s
 * `resolveMcpRedirectUri` takes `topology` as a parameter, resolved by its
 * two callers (also `shell/`) at the point they actually need a redirect
 * URI — the same ownership rule, not a relocation to fix. See
 * `docs/work-unit.md` phase 6c.
 *
 * `secrets` (#2276 slice C, done): unlike `network`, this domain's call site
 * WAS a privileged operation with a broker equivalent —
 * `scoops/scoop-context/shell-and-skills.ts` now calls
 * `broker.secrets.listMaskedEnv()` (already implemented by every slice-B
 * adapter) instead of `core/secret-env.ts`'s topology-branching
 * `fetchSecretEnvVars()`. `buildEnvFromMaskedEntries` — the POSIX-name filter
 * + `GITHUB_TOKEN`/`GH_TOKEN` alias — is exported from `core/secret-env.ts`
 * and reused as-is, so the shell env shape is unchanged; any
 * `CapabilityResult.ok === false` degrades to `{}`, matching the old
 * fail-silent contract. `fetchSecretEnvVars()` stays exported for `ui/wc/
 * wc-live.ts` (`ui/` is not a banned layer). `shell/supplemental-commands/
 * secret-command.ts` keeps reading `resolveFloatTopology()` directly — that
 * file is `shell/`, which owns topology (same rule as `redirect-uri.ts`'s
 * callers), and its CRUD surface (`set`/`get`/`peek`/`scope`/`list`/`delete`/
 * `test`/`edit`) has no `broker.secrets` equivalent, so no allowlist op was
 * added. See `docs/work-unit.md` phase 6d.
 *
 * `mounts` (#2276 slice C, done): `fs/mount/signed-fetch.ts`'s S3/DA
 * sign-and-forward transport now calls `broker.mounts.signRequest({ backend,
 * envelope })` instead of re-implementing the same extension-direct /
 * extension-delegate / node-rest branch every slice-B adapter already
 * carries. `envelopeToResponse` — the error-code → `FsError` mapping — is
 * UNCHANGED: a server-encoded refusal (`profile_not_configured`, …) travels
 * as a `SignAndForwardReply` value inside a successful `CapabilityResult`,
 * not as a broker-level failure. The broker is a module-level fact
 * (`fs/mount/capability-broker.ts`, its own tiny module so `kernel/host.ts`
 * setting it eagerly does not drag `signed-fetch.ts`'s lazy chunk — SigV4
 * envelope building, the IMS client — onto the eager boot graph), set once
 * next to `orchestrator.setCapabilityBroker`: `fs/` sits at the bottom of
 * the layer stack and mount construction happens far from any composition
 * root (`VirtualFS.mount()`, `mount-commands.ts`, `mount-recovery.ts`), so
 * constructor injection would fan out through all of them. An UNSET broker
 * is a fail-closed `CapabilityUnavailable`, never a silent `node-rest`
 * guess: a composition miss on an extension topology must not POST a
 * signed envelope — IMS bearer included — to the hosted origin's REST
 * routes. `mounts.signRequest` also carries its own 120s deadline on the
 * `node-rest` adapter (`MOUNT_SIGN_TIMEOUT_MS` in `rest-ops.ts`) and the
 * `extension-direct` leg (`DIRECT_MOUNT_SIGN_TIMEOUT_MS` in
 * `extension-ops.ts`) — an OBJECT TRANSFER (S3 caps a single object at
 * 25 MiB), not a control call, so it must not inherit the 10s
 * `CONTROL_CALL_TIMEOUT_MS` every other REST op uses; `extension-delegate`
 * already had this via `mount-bridge-client.ts`'s own `CALL_TIMEOUT_MS`.
 *
 * `fs/mount-commands.ts`'s extension-popup-vs-direct-picker branch and
 * `fs/picker-popup.ts`'s shared 4-kind popup launcher both KEEP
 * `isExtensionRealm()` — not an oversight. Both decide how to host a
 * directory picker's required page gesture, exactly what
 * `CapabilityBroker`'s `PageGestureChannel` / `mounts.pickDirectory()` was
 * designed for (slice B), but no real `PageGestureChannel` implementation
 * exists anywhere yet — `kernel/host.ts`'s `config.pageGestures` is never
 * supplied in production, so `mounts.pickDirectory()` is unconditionally
 * `CapabilityUnavailable` today. Routing through it now would BREAK
 * local-mount picking, not migrate it; wiring a real page-gesture channel
 * (bridging a page-realm gesture from the kernel worker) is separate,
 * larger follow-up work. See `docs/work-unit.md` phase 6e.
 *
 * TODO(#2276) slice C, remaining domains — privileged call sites in `scoops/`
 * / `tools/` / `kernel/` that still branch on float / topology
 * (`isChromeExtensionRealm` / `isExtensionRealm` / `hasLocalNodeServer` /
 * `resolveFloatTopology` / `getChromeExtensionRealm` /
 * `setChromeExtensionRealm`) rather than asking an injected `CapabilityBroker`
 * or taking a composition-time answer. One PR per domain, smallest first:
 *
 * TODO(#2276) slice D, the lint gate — a plain identifier grep on this list is
 * NOT sufficient by itself: `export const isTrayExtension =
 * getChromeExtensionRealm` inside `shell/tray-fetch.ts`, imported by `scoops/`
 * under that new name, would reintroduce the exact branch this slice removed
 * without tripping a name-keyed gate. The gate must ban a `scoops/` / `tools/`
 * / `kernel/` (except `kernel/host.ts`) import chain that RESOLVES to the
 * cached realm fact, not just a literal name match — re-exports included.
 * Two more names belong on the ban list: `hasChromeRuntimeConnect`
 * (`base/runtime-env.ts`) and its `@slicc/shared-ts` original,
 * `canConnectToChromeRuntime` — both are true on the thin-bridge hosted page
 * and are float signals just like the other six.
 *
 * approvals
 *   - sudo/index.ts `createSudoBroker`
 * browser
 *   - shell/supplemental-commands/playwright/handlers/snapshot.ts
 * leftovers (take a composition-time answer, not a probe)
 *   - kernel/telemetry.ts, kernel/host.ts `shouldStartLickWsBridge`,
 *     shell/supplemental-commands/webhook-command.ts, crontask-command.ts
 *
 * `ui/` sites stay as they are: UI composition may know its float.
 */

export type {
  CapabilityImplementations,
  ComposeCapabilityBrokerOptions,
} from './compose.js';
export { composeCapabilityBroker } from './compose.js';
export {
  type ConnectCapabilityBrokerOptions,
  createConnectCapabilityBroker,
} from './connect-adapter.js';
export {
  createExtensionCapabilityBroker,
  type ExtensionCapabilityBrokerOptions,
  type ExtensionCapabilityTransports,
  type ExtensionFetchResult,
  type SecretsControlMessage,
} from './extension-adapter.js';
export {
  type CapabilityBrokerForTopologyOptions,
  createCapabilityBrokerForTopology,
} from './for-topology.js';
export {
  createRestCapabilityBroker,
  REST_CAPABILITY_PATHS,
  type RestCapabilityBrokerOptions,
} from './rest-adapter.js';

export {
  APPROVAL_OPERATIONS,
  type ApprovalCapability,
  type ApprovalDecision,
  type ApprovalDenialReason,
  type ApprovalOperation,
  type ApprovalRequest,
  BROWSER_OPERATIONS,
  type BrowserCapability,
  type BrowserCreateTargetRequest,
  type BrowserEvaluateRequest,
  type BrowserEvaluateResult,
  type BrowserNavigateRequest,
  type BrowserOperation,
  type BrowserScreenshotRequest,
  type BrowserScreenshotResult,
  type BrowserTarget,
  CAPABILITY_ADAPTERS,
  CAPABILITY_DOMAINS,
  type CapabilityAdapterId,
  type CapabilityBroker,
  type CapabilityDomain,
  type CapabilityFailure,
  type CapabilityResult,
  type CapabilityUnavailable,
  capabilityFailed,
  capabilityUnavailable,
  DEVICE_OPERATIONS,
  type DeviceCapability,
  type DeviceHandle,
  type DeviceOperation,
  type DeviceRequest,
  isCapabilityFailure,
  isCapabilityUnavailable,
  type LocalNodeServerStatus,
  MOUNT_OPERATIONS,
  type MountCapability,
  type MountDirectoryHandle,
  type MountOperation,
  type MountSignBackend,
  type MountSignRequest,
  type MountSignResult,
  NETWORK_OPERATIONS,
  type NetworkBodyEncoding,
  type NetworkCapability,
  type NetworkFetchRequest,
  type NetworkFetchResponse,
  type NetworkOperation,
  type NetworkWebsocketHandle,
  type NetworkWebsocketRequest,
  type PageGestureChannel,
  SECRET_OPERATIONS,
  type SecretCapability,
  type SecretDeleteRequest,
  type SecretDeleteResult,
  type SecretGetRequest,
  type SecretListResult,
  type SecretMaskedEnvEntry,
  type SecretOperation,
  type SecretSetRequest,
} from './types.js';
