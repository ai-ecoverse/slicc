/**
 * CapabilityBroker protocol (#2276, Phase 6 of #1666).
 *
 * TODO(#2276): remaining privileged call sites still branching on float /
 * topology (`isChromeExtensionRealm` / `isExtensionRealm` /
 * `hasLocalNodeServer` / `resolveFloatTopology`) rather than this broker.
 * Slice A migrates `scoops/scoop-context/shell-and-skills.ts` webhook
 * topology (`network.localNodeServer`). Left:
 *
 * scoops/
 *   - tray-leader.ts `createTrayFetch` — network.crossOriginFetch
 *   - scoop-context/shell-and-skills.ts `fetchSecretEnvVars` — secrets.listMaskedEnv
 *   - scoop-context/shell-and-skills.ts `getLeaderStatusWithFallback` — tray status
 * tools/
 *   - (none call isExtensionRealm today)
 * nearby composition-time candidates (not scoops/tools):
 *   - sudo/index.ts `createSudoBroker` — approvals.request
 *   - fs/mount-commands.ts, fs/mount/signed-fetch.ts — mounts.signRequest / pickDirectory
 *   - shell/proxied-fetch.ts — network.crossOriginFetch
 *   - shell/supplemental-commands/playwright/handlers/snapshot.ts — browser.screenshot
 *   - kernel/telemetry.ts, kernel/host.ts `shouldStartLickWsBridge` — leftover probes
 */

export { createNodeCapabilityBroker } from './node-adapter.js';
export { createPageCapabilityBroker, type PageCapabilityBrokerOptions } from './page-adapter.js';
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
  CAPABILITY_DOMAINS,
  type CapabilityBroker,
  type CapabilityDomain,
  type CapabilityResult,
  type CapabilityUnavailable,
  capabilityUnavailable,
  DEVICE_OPERATIONS,
  type DeviceCapability,
  type DeviceHandle,
  type DeviceOperation,
  type DeviceRequest,
  isCapabilityUnavailable,
  type LocalNodeServerStatus,
  MOUNT_OPERATIONS,
  type MountCapability,
  type MountDirectoryHandle,
  type MountOperation,
  type MountSignRequest,
  type MountSignResult,
  NETWORK_OPERATIONS,
  type NetworkCapability,
  type NetworkFetchRequest,
  type NetworkFetchResponse,
  type NetworkOperation,
  type NetworkWebsocketHandle,
  type NetworkWebsocketRequest,
  SECRET_OPERATIONS,
  type SecretCapability,
  type SecretDeleteRequest,
  type SecretGetRequest,
  type SecretListResult,
  type SecretMaskedEnvEntry,
  type SecretOperation,
  type SecretSetRequest,
  type SecretValue,
} from './types.js';
