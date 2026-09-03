/**
 * CapabilityBroker protocol (#2276, Phase 6 of #1666).
 *
 * Slice A shipped the protocol and one page stub. Slice B replaced the stubs
 * with real adapters keyed by float topology (`node-rest`, `extension-direct`,
 * `extension-delegate`, `connect`), composed once in `kernel/host.ts`. Slice C
 * removes float probes from `scoops/` / `tools/` / `kernel/` business logic
 * (review-patterns category 10), one domain per PR — network is done.
 *
 * `network` (#2276 slice C, done): none of `scoops/tray-leader.ts`
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
 * TODO(#2276) slice C, remaining domains — privileged call sites in `scoops/`
 * / `tools/` / `kernel/` that still branch on float / topology
 * (`isChromeExtensionRealm` / `isExtensionRealm` / `hasLocalNodeServer` /
 * `resolveFloatTopology` / `getChromeExtensionRealm` /
 * `setChromeExtensionRealm`) rather than asking an injected `CapabilityBroker`
 * or taking a composition-time answer. One PR per domain, smallest first:
 *
 * secrets
 *   - scoops/scoop-context/shell-and-skills.ts `fetchSecretEnvVars`
 *   - shell/supplemental-commands/secret-command.ts
 * mounts
 *   - fs/mount-commands.ts, fs/mount/signed-fetch.ts, fs/picker-popup.ts
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
