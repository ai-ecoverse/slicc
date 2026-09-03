/**
 * `CapabilityBroker` — privileged operations as an injected contract
 * (#2276, Phase 6 of #1666).
 *
 * A work unit never asks "am I running in the extension?". It asks this
 * broker for browser / network / secrets / devices / mounts / approvals and
 * receives a typed {@link CapabilityResult} — either a value or
 * {@link CapabilityUnavailable}. Runtime detection happens at kernel-host
 * composition time; adapters are the only place a float name may appear.
 *
 * Privileged request protocols use explicit per-operation allowlists, not
 * generic shared handler maps.
 */

import type {
  DaSignAndForwardEnvelope,
  S3SignAndForwardEnvelope,
  SignAndForwardReply,
  TraySudoKind,
} from '@slicc/shared-ts';
import type { SudoApproverDirective } from '../../sudo/types.js';

/**
 * Which float transport an adapter speaks.
 *
 * Deliberately the same four names as `shell/float-topology.ts`'s
 * `FloatTopology`: topology IS the capability axis (a Node CLI and a Swift
 * server expose the identical `/api/*` routes, so both are `node-rest`),
 * and the host passes its resolved topology straight through. Declared here
 * rather than imported so `work-unit/` does not depend on `shell/`; the
 * assignment in `kernel/host.ts` is the compile-time check that the two
 * unions stay in sync.
 */
export const CAPABILITY_ADAPTERS = [
  'node-rest',
  'extension-direct',
  'extension-delegate',
  'connect',
] as const;
export type CapabilityAdapterId = (typeof CAPABILITY_ADAPTERS)[number];

export const CAPABILITY_DOMAINS = [
  'browser',
  'network',
  'secrets',
  'devices',
  'mounts',
  'approvals',
] as const;
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number];

export const BROWSER_OPERATIONS = [
  'listTargets',
  'createTarget',
  'navigate',
  'screenshot',
  'evaluate',
] as const;
export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number];

export const NETWORK_OPERATIONS = ['localNodeServer', 'crossOriginFetch', 'websocket'] as const;
export type NetworkOperation = (typeof NETWORK_OPERATIONS)[number];

export const SECRET_OPERATIONS = ['listMaskedEnv', 'getMasked', 'set', 'delete'] as const;
export type SecretOperation = (typeof SECRET_OPERATIONS)[number];

export const DEVICE_OPERATIONS = ['usbRequest', 'serialRequest', 'hidRequest'] as const;
export type DeviceOperation = (typeof DEVICE_OPERATIONS)[number];

export const MOUNT_OPERATIONS = ['signRequest', 'pickDirectory', 'recover'] as const;
export type MountOperation = (typeof MOUNT_OPERATIONS)[number];

export const APPROVAL_OPERATIONS = ['request', 'resolve'] as const;
export type ApprovalOperation = (typeof APPROVAL_OPERATIONS)[number];

/**
 * Typed miss — this float has no transport for the operation at all. Never a
 * thrown string, and never used for a call that reached the transport and
 * came back wrong: that is {@link CapabilityFailure}.
 */
export interface CapabilityUnavailable {
  ok: false;
  reason: 'unavailable';
  capability: CapabilityDomain;
  operation: string;
  message: string;
}

/**
 * The transport exists and was reached, but the call did not succeed (HTTP
 * 5xx, a disconnected Port, a malformed reply).
 *
 * Deliberately distinct from {@link CapabilityUnavailable}: "this float can
 * never do that" and "that attempt failed" call for different handling — the
 * first is a permanent shape fact a caller can branch on once at composition,
 * the second is retryable and worth surfacing to the user. Both are
 * `ok: false`, so a caller that only checks `ok` still fails closed.
 */
export interface CapabilityFailure {
  ok: false;
  reason: 'failed';
  capability: CapabilityDomain;
  operation: string;
  message: string;
  /** Upstream HTTP status, when the transport had one. */
  status?: number;
}

export type CapabilityResult<T> =
  | { ok: true; value: T }
  | CapabilityUnavailable
  | CapabilityFailure;

export function isCapabilityUnavailable(
  result: CapabilityResult<unknown>
): result is CapabilityUnavailable {
  return result.ok === false && result.reason === 'unavailable';
}

export function isCapabilityFailure(
  result: CapabilityResult<unknown>
): result is CapabilityFailure {
  return result.ok === false && result.reason === 'failed';
}

export function capabilityUnavailable(
  capability: CapabilityDomain,
  operation: string,
  message: string
): CapabilityUnavailable {
  return { ok: false, reason: 'unavailable', capability, operation, message };
}

export function capabilityFailed(
  capability: CapabilityDomain,
  operation: string,
  message: string,
  status?: number
): CapabilityFailure {
  return {
    ok: false,
    reason: 'failed',
    capability,
    operation,
    message,
    ...(status === undefined ? {} : { status }),
  };
}

export interface BrowserTarget {
  id: string;
  url: string;
}

export interface BrowserCreateTargetRequest {
  url: string;
}

export interface BrowserNavigateRequest {
  targetId: string;
  url: string;
}

export interface BrowserScreenshotRequest {
  targetId: string;
}

export interface BrowserScreenshotResult {
  mimeType: string;
  base64: string;
}

export interface BrowserEvaluateRequest {
  targetId: string;
  expression: string;
}

export interface BrowserEvaluateResult {
  json: string;
}

export interface LocalNodeServerStatus {
  available: true;
}

/** How a {@link NetworkFetchRequest} / {@link NetworkFetchResponse} body string is encoded. */
export type NetworkBodyEncoding = 'text' | 'base64';

export interface NetworkFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Request body, encoded per {@link NetworkFetchRequest.bodyEncoding}. */
  body?: string;
  /** Defaults to `'text'`. Binary bodies MUST say `'base64'`. */
  bodyEncoding?: NetworkBodyEncoding;
  /**
   * Cancels the request. A cross-origin fetch has no meaningful fixed
   * deadline — a multi-MB download is not a hang — so the caller owns the
   * budget here, unlike the small control-plane calls which carry their own.
   */
  signal?: AbortSignal;
}

export interface NetworkFetchResponse {
  status: number;
  ok: boolean;
  statusText: string;
  headers: Record<string, string>;
  /** Response body, encoded per {@link NetworkFetchResponse.bodyEncoding}. */
  body: string;
  /** `'base64'` whenever the response content type is not textual. */
  bodyEncoding: NetworkBodyEncoding;
  /** Final URL after redirects. */
  url: string;
}

export interface NetworkWebsocketRequest {
  url: string;
}

export interface NetworkWebsocketHandle {
  id: string;
}

export interface SecretMaskedEnvEntry {
  name: string;
  maskedValue: string;
  domains?: readonly string[];
}

export interface SecretListResult {
  entries: readonly SecretMaskedEnvEntry[];
}

export interface SecretGetRequest {
  name: string;
}

export interface SecretSetRequest {
  name: string;
  value: string;
  /**
   * Domains the secret may be sent to. Empty (the default) scopes it to
   * nothing, which is the fail-closed choice.
   */
  domains?: readonly string[];
  /**
   * `'session'` (the DEFAULT) keeps the value in the trusted realm's memory
   * only; `'persisted'` writes it durably (`~/.slicc/secrets.env` on the Node
   * server, extension storage in the extension).
   *
   * Session-by-default matches `secret set`, where persisting takes an
   * explicit `--persist`. A durable write is not something a caller should
   * get by omitting a field.
   */
  scope?: 'session' | 'persisted';
}

export interface SecretDeleteRequest {
  name: string;
}

export interface SecretDeleteResult {
  /** Whether a secret with that name existed before the call. */
  removed: boolean;
  /**
   * Which store it came out of. The `secret` command prints this, so it is
   * part of the result rather than something the caller re-derives.
   */
  fromSession: boolean;
}

export interface DeviceRequest {
  filters?: readonly string[];
}

export interface DeviceHandle {
  id: string;
  kind: 'usb' | 'serial' | 'hid';
}

/** Which signing backend a {@link MountSignRequest} envelope targets. */
export type MountSignBackend = 's3' | 'da';

/**
 * A sign-and-forward envelope. The privileged realm resolves credentials,
 * signs, forwards upstream and returns the reply — the caller never holds
 * the S3 keys (the DA leg carries a transient IMS bearer it already has).
 */
export type MountSignRequest =
  | { backend: 's3'; envelope: S3SignAndForwardEnvelope }
  | { backend: 'da'; envelope: DaSignAndForwardEnvelope };

/**
 * The upstream reply. `ok: false` is a signing / upstream failure, which is
 * NOT the same as {@link CapabilityUnavailable}: the transport worked, the
 * request did not. A float with no sign-and-forward transport at all returns
 * `CapabilityUnavailable` instead.
 */
export type MountSignResult = SignAndForwardReply;

export interface MountDirectoryHandle {
  id: string;
  name: string;
}

export interface ApprovalRequest {
  /**
   * Shared with the tray wire (`TraySudoKind`) because a prompt may be
   * delegated to a follower's human (#2062). Imported rather than re-listed
   * so a kind added there cannot silently fail closed here.
   */
  kind: TraySudoKind;
  /** The concrete command line or VFS path being gated. */
  detail: string;
  /**
   * Who is asking, as the SYSTEM authenticated them — never as they describe
   * themselves. Rendered as prompt chrome, separate from `detail`.
   */
  requester?: string;
  /**
   * Editable default pattern for an "Always" grant. Suggesting one is policy
   * (it can cost an LLM call), so the broker forwards what it is given and
   * falls back to `detail`; it never suggests.
   */
  suggestedPattern?: string;
  /**
   * Route this request to a non-human approver (a cone, a delegated scoop, a
   * bounded approver agent). Absent keeps the owner's own native gesture.
   * Carried whole because "who decides" is part of what is being asked, and
   * set from trusted state only — for a biscotto it comes from the seat
   * record the tray hub stamped, never from anything the guest sent.
   */
  approver?: SudoApproverDirective;
  /**
   * Cancels the adapter's transport hop. This is NOT the human-decision
   * budget: that lives in `sudo/`'s `withApprovalTimeout` (see
   * {@link ApprovalCapability}). Aborting here abandons the relay, not the
   * prompt.
   */
  signal?: AbortSignal;
}

export type ApprovalDenialReason = 'user-timeout' | 'cone-timeout';

export interface ApprovalDecision {
  decision: 'allow' | 'deny' | 'always';
  /** The (human-edited) glob pattern to persist. Only set for `always`. */
  pattern?: string;
  /**
   * Why a `deny` was reached when nobody refused. Absent for a real gesture.
   * Mirrors `SudoDecision.reason` so unanswered approvals are not treated as
   * genuine refusals (which would immediately re-request the same action).
   */
  reason?: ApprovalDenialReason;
}

export interface BrowserCapability {
  readonly allowlist: readonly BrowserOperation[];
  supports(op: BrowserOperation): boolean;
  listTargets(): Promise<CapabilityResult<readonly BrowserTarget[]>>;
  createTarget(request: BrowserCreateTargetRequest): Promise<CapabilityResult<BrowserTarget>>;
  navigate(request: BrowserNavigateRequest): Promise<CapabilityResult<void>>;
  screenshot(request: BrowserScreenshotRequest): Promise<CapabilityResult<BrowserScreenshotResult>>;
  evaluate(request: BrowserEvaluateRequest): Promise<CapabilityResult<BrowserEvaluateResult>>;
}

export interface NetworkCapability {
  readonly allowlist: readonly NetworkOperation[];
  supports(op: NetworkOperation): boolean;
  localNodeServer(): Promise<CapabilityResult<LocalNodeServerStatus>>;
  crossOriginFetch(request: NetworkFetchRequest): Promise<CapabilityResult<NetworkFetchResponse>>;
  websocket(request: NetworkWebsocketRequest): Promise<CapabilityResult<NetworkWebsocketHandle>>;
}

/**
 * Secrets, as the AGENT realm may see them: masked values only. There is no
 * operation that returns plaintext, and there will not be one — the real
 * value never leaves the trusted realm.
 *
 * Deliberately smaller than the `secret` command's backend. `peek`, `scope`
 * and `test` are NOT here: allowlists are explicit, so slice C's secrets PR
 * adds each operation as it migrates that call site, and until then a caller
 * asking for one gets a compile error rather than a silent miss.
 */
export interface SecretCapability {
  readonly allowlist: readonly SecretOperation[];
  supports(op: SecretOperation): boolean;
  listMaskedEnv(): Promise<CapabilityResult<SecretListResult>>;
  /** Named `getMasked`, not `get`, because plaintext is not on offer. */
  getMasked(request: SecretGetRequest): Promise<CapabilityResult<SecretMaskedEnvEntry>>;
  set(request: SecretSetRequest): Promise<CapabilityResult<void>>;
  delete(request: SecretDeleteRequest): Promise<CapabilityResult<SecretDeleteResult>>;
}

export interface DeviceCapability {
  readonly allowlist: readonly DeviceOperation[];
  supports(op: DeviceOperation): boolean;
  usbRequest(request: DeviceRequest): Promise<CapabilityResult<DeviceHandle>>;
  serialRequest(request: DeviceRequest): Promise<CapabilityResult<DeviceHandle>>;
  hidRequest(request: DeviceRequest): Promise<CapabilityResult<DeviceHandle>>;
}

export interface MountCapability {
  readonly allowlist: readonly MountOperation[];
  supports(op: MountOperation): boolean;
  signRequest(request: MountSignRequest): Promise<CapabilityResult<MountSignResult>>;
  pickDirectory(): Promise<CapabilityResult<MountDirectoryHandle>>;
  recover(): Promise<CapabilityResult<void>>;
}

/**
 * The NATIVE-GESTURE HOP, and only that: "put this in front of whoever
 * decides on this float, and give me their answer".
 *
 * Everything around that hop is POLICY and stays in `sudo/`, above the
 * broker — tray-first delegation to a follower's human
 * (`createTrayFirstSudoBroker`), the 5-minute human-decision budget and its
 * `reason: 'user-timeout'` deny (`withApprovalTimeout`), cone/scoop/agent
 * routing (`createConeApprovalBroker`), and pattern suggestion. Slice C's
 * approvals PR WRAPS this capability inside `createSudoBroker`; it does not
 * replace `createSudoBroker` with it. An adapter that grew a human-decision
 * timeout would silently shorten every one of those policies.
 *
 * `ApprovalRequest.signal` is therefore a transport deadline only.
 */
export interface ApprovalCapability {
  readonly allowlist: readonly ApprovalOperation[];
  supports(op: ApprovalOperation): boolean;
  request(request: ApprovalRequest): Promise<CapabilityResult<ApprovalDecision>>;
  resolve(request: ApprovalRequest): Promise<CapabilityResult<ApprovalDecision>>;
}

/**
 * The ops that need a real user gesture in a realm with a document.
 *
 * A directory picker and the WebUSB / WebSerial / WebHID choosers only open
 * from a page-realm gesture, in EVERY topology — so they are a channel the
 * host injects once, not a per-topology adapter. An adapter composed without
 * one leaves those ops {@link CapabilityUnavailable}.
 */
export interface PageGestureChannel {
  pickDirectory(): Promise<CapabilityResult<MountDirectoryHandle>>;
  usbRequest(request: DeviceRequest): Promise<CapabilityResult<DeviceHandle>>;
  serialRequest(request: DeviceRequest): Promise<CapabilityResult<DeviceHandle>>;
  hidRequest(request: DeviceRequest): Promise<CapabilityResult<DeviceHandle>>;
}

export interface CapabilityBroker {
  /** Adapter identity for logs and the conformance suite — not a float probe. */
  readonly adapter: CapabilityAdapterId;
  readonly browser: BrowserCapability;
  readonly network: NetworkCapability;
  readonly secrets: SecretCapability;
  readonly devices: DeviceCapability;
  readonly mounts: MountCapability;
  readonly approvals: ApprovalCapability;
}
