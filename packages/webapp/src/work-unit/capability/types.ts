import type {
  DaSignAndForwardEnvelope,
  S3SignAndForwardEnvelope,
  SignAndForwardReply,
  TraySudoKind,
} from '@slicc/shared-ts';
import type { SudoApproverDirective } from '../../sudo/types.js';

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

export interface CapabilityUnavailable {
  ok: false;
  reason: 'unavailable';
  capability: CapabilityDomain;
  operation: string;
  message: string;
}

export interface CapabilityFailure {
  ok: false;
  reason: 'failed';
  capability: CapabilityDomain;
  operation: string;
  message: string;

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

export type NetworkBodyEncoding = 'text' | 'base64';

export interface NetworkFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;

  body?: string;

  bodyEncoding?: NetworkBodyEncoding;

  signal?: AbortSignal;
}

export interface NetworkFetchResponse {
  status: number;
  ok: boolean;
  statusText: string;
  headers: Record<string, string>;

  body: string;

  bodyEncoding: NetworkBodyEncoding;

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

  domains?: readonly string[];

  scope?: 'session' | 'persisted';
}

export interface SecretDeleteRequest {
  name: string;
}

export interface SecretDeleteResult {
  removed: boolean;

  fromSession: boolean;
}

export interface DeviceRequest {
  filters?: readonly string[];
}

export interface DeviceHandle {
  id: string;
  kind: 'usb' | 'serial' | 'hid';
}

export type MountSignBackend = 's3' | 'da';

export type MountSignRequest =
  | { backend: 's3'; envelope: S3SignAndForwardEnvelope }
  | { backend: 'da'; envelope: DaSignAndForwardEnvelope };

export type MountSignResult = SignAndForwardReply;

export interface MountDirectoryHandle {
  id: string;
  name: string;
}

export interface ApprovalRequest {
  kind: TraySudoKind;

  detail: string;

  requester?: string;

  suggestedPattern?: string;

  approver?: SudoApproverDirective;

  signal?: AbortSignal;
}

export type ApprovalDenialReason = 'user-timeout' | 'cone-timeout';

export interface ApprovalDecision {
  decision: 'allow' | 'deny' | 'always';

  pattern?: string;

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

export interface ApprovalCapability {
  readonly allowlist: readonly ApprovalOperation[];
  supports(op: ApprovalOperation): boolean;
  request(request: ApprovalRequest): Promise<CapabilityResult<ApprovalDecision>>;
  resolve(request: ApprovalRequest): Promise<CapabilityResult<ApprovalDecision>>;
}

export interface PageGestureChannel {
  pickDirectory(): Promise<CapabilityResult<MountDirectoryHandle>>;
  usbRequest(request: DeviceRequest): Promise<CapabilityResult<DeviceHandle>>;
  serialRequest(request: DeviceRequest): Promise<CapabilityResult<DeviceHandle>>;
  hidRequest(request: DeviceRequest): Promise<CapabilityResult<DeviceHandle>>;
}

export interface CapabilityBroker {
  readonly adapter: CapabilityAdapterId;
  readonly browser: BrowserCapability;
  readonly network: NetworkCapability;
  readonly secrets: SecretCapability;
  readonly devices: DeviceCapability;
  readonly mounts: MountCapability;
  readonly approvals: ApprovalCapability;
}
