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

export const SECRET_OPERATIONS = ['listMaskedEnv', 'get', 'set', 'delete'] as const;
export type SecretOperation = (typeof SECRET_OPERATIONS)[number];

export const DEVICE_OPERATIONS = ['usbRequest', 'serialRequest', 'hidRequest'] as const;
export type DeviceOperation = (typeof DEVICE_OPERATIONS)[number];

export const MOUNT_OPERATIONS = ['signRequest', 'pickDirectory', 'recover'] as const;
export type MountOperation = (typeof MOUNT_OPERATIONS)[number];

export const APPROVAL_OPERATIONS = ['request', 'resolve'] as const;
export type ApprovalOperation = (typeof APPROVAL_OPERATIONS)[number];

/** Typed miss — never a thrown string. */
export interface CapabilityUnavailable {
  ok: false;
  reason: 'unavailable';
  capability: CapabilityDomain;
  operation: string;
  message: string;
}

export type CapabilityResult<T> = { ok: true; value: T } | CapabilityUnavailable;

export function isCapabilityUnavailable(
  result: CapabilityResult<unknown>
): result is CapabilityUnavailable {
  return result.ok === false;
}

export function capabilityUnavailable(
  capability: CapabilityDomain,
  operation: string,
  message: string
): CapabilityUnavailable {
  return { ok: false, reason: 'unavailable', capability, operation, message };
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

export interface NetworkFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Request body bytes as base64 when binary; plain text otherwise. */
  body?: string;
}

export interface NetworkFetchResponse {
  status: number;
  ok: boolean;
  statusText: string;
  headers: Record<string, string>;
  /** Response body bytes as base64 when binary; plain text / latin1 otherwise. */
  body: string;
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

export interface SecretValue {
  name: string;
  maskedValue: string;
}

export interface SecretSetRequest {
  name: string;
  value: string;
}

export interface SecretDeleteRequest {
  name: string;
}

export interface DeviceRequest {
  filters?: readonly string[];
}

export interface DeviceHandle {
  id: string;
  kind: 'usb' | 'serial' | 'hid';
}

export interface MountSignRequest {
  url: string;
}

export interface MountSignResult {
  url: string;
}

export interface MountDirectoryHandle {
  id: string;
  name: string;
}

export interface ApprovalRequest {
  kind: 'command' | 'read' | 'write' | 'secret' | 'export';
  detail: string;
}

export type ApprovalDenialReason = 'user-timeout' | 'cone-timeout';

export interface ApprovalDecision {
  decision: 'allow' | 'deny';
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

export interface SecretCapability {
  readonly allowlist: readonly SecretOperation[];
  supports(op: SecretOperation): boolean;
  listMaskedEnv(): Promise<CapabilityResult<SecretListResult>>;
  get(request: SecretGetRequest): Promise<CapabilityResult<SecretValue>>;
  set(request: SecretSetRequest): Promise<CapabilityResult<void>>;
  delete(request: SecretDeleteRequest): Promise<CapabilityResult<void>>;
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

export interface ApprovalCapability {
  readonly allowlist: readonly ApprovalOperation[];
  supports(op: ApprovalOperation): boolean;
  request(request: ApprovalRequest): Promise<CapabilityResult<ApprovalDecision>>;
  resolve(request: ApprovalRequest): Promise<CapabilityResult<ApprovalDecision>>;
}

export interface CapabilityBroker {
  /** Adapter identity for logs and the conformance suite — not a float probe. */
  readonly adapter: 'page' | 'node';
  readonly browser: BrowserCapability;
  readonly network: NetworkCapability;
  readonly secrets: SecretCapability;
  readonly devices: DeviceCapability;
  readonly mounts: MountCapability;
  readonly approvals: ApprovalCapability;
}
