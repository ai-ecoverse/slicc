/**
 * CapabilityBroker protocol (#2276, Phase 6 of #1666).
 *
 * Slice A shipped the protocol and one page stub. Slice B replaced the stubs
 * with real adapters keyed by float topology (`node-rest`, `extension-direct`,
 * `extension-delegate`, `connect`), composed once in `kernel/host.ts`. Slice C
 * migrates the remaining privileged call sites off direct float probes, one
 * PR per domain — network is done.
 *
 * `network` (#2276 slice C, done): `scoops/tray-leader.ts` (`createTrayFetch`),
 * `shell/proxied-fetch.ts` (`createProxiedFetch`) and `shell/mcp/redirect-uri.ts`
 * were NOT rewired onto `broker.network.crossOriginFetch` — they are
 * `SecureFetch`-shaped transport factories called from 18+ shell sites with
 * no broker in scope, not privileged operations behind an allowlist, so
 * threading a broker instance through all of them would have been a
 * different, much larger refactor. Instead each call site takes the ANSWER
 * by injection rather than probing: `tray-leader.ts` and `proxied-fetch.ts`
 * read `getChromeExtensionRealm()` (`base/api-endpoint.ts`'s lazily-cached,
 * per-realm fact — resolved once, not re-probed per call, mirroring the
 * existing `extensionDelegateId` / `localApiBaseUrl` idiom in that same
 * module); `redirect-uri.ts`'s `resolveMcpRedirectUri` takes `topology` as a
 * parameter, resolved by its two callers at the point they actually need a
 * redirect URI. See `docs/work-unit.md` phase 6c.
 *
 * TODO(#2276) slice C, remaining domains — privileged call sites that still
 * branch on float / topology (`isChromeExtensionRealm` / `isExtensionRealm` /
 * `hasLocalNodeServer` / `resolveFloatTopology`) rather than this broker.
 * One PR per domain, smallest first:
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
