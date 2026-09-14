import type {
  CDPPayload,
  FollowerBiscottoGate,
  OAuthExtraDomainsStore,
  SignAndForwardReply,
} from '@slicc/shared-ts';
import type { SecretRequest, SecretRequestOutcome } from '../base/secret-request-registry.js';
import type {
  DockTreeSpecLike,
  DockZoneName,
  SurfaceSizeSpecLike,
} from '../core/dock-tree-spec.js';
import type { LeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import type { TrayLeaveResult } from '../scoops/tray-leave.js';
import type { SidecarAttachmentInfo, SidecarRunResult } from '../scoops/tray-sidecar.js';
import type { SudoDecision, SudoRequest } from '../sudo/types.js';
import type { HidDeviceFilter, HidDeviceInfo } from './hid-device-registry.js';
import type { CameraCaptureRequest, CameraCaptureResult } from './panel-rpc-camera-types.js';
import type {
  SerialDeviceInfo,
  SerialFilter,
  SerialInputSignals,
  SerialOpenOptions,
  SerialOutputSignals,
} from './serial-port-registry.js';
import type { UsbControlSetup, UsbDeviceFilter, UsbDeviceInfo } from './usb-device-registry.js';

const PANEL_RPC_CHANNEL = 'slicc-panel-rpc';
const DEFAULT_TIMEOUT_MS = 15_000;

export const PANEL_RPC_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

export function panelRpcChannelName(instanceId?: string): string {
  return instanceId ? `${PANEL_RPC_CHANNEL}:${instanceId}` : PANEL_RPC_CHANNEL;
}

export type PanelRpcRequest =
  | { op: 'page-info'; payload?: undefined }
  | {
      op: 'screencapture';
      payload: { mimeType: string; quality: number };
    }
  | {
      op: 'speak-text';
      payload: {
        text: string;
        lang?: string;
        voice?: string;
        rate?: number;
        pitch?: number;
        volume?: number;
      };
    }
  | {
      op: 'list-voices';
      payload?: undefined;
    }
  | { op: 'speak-status'; payload?: undefined }
  | { op: 'speak-warmup'; payload?: undefined }
  | {
      op: 'synthesize-to-wav';
      payload: { text: string; lang?: string; voice?: string; rate?: number };
    }
  | {
      op: 'play-audio';
      payload: { bytes: ArrayBuffer; mimeType?: string; volume?: number };
    }
  | {
      op: 'play-chime';
      payload: { tone?: 'success' | 'error' | 'notify' };
    }
  | { op: 'clipboard-read-text'; payload?: undefined }
  | { op: 'clipboard-write-text'; payload: { text: string } }
  | {
      op: 'clipboard-write-image';
      payload: { bytes: ArrayBuffer; mimeType: string };
    }
  | {
      op: 'window-open';
      payload: { url: string; target?: string; features?: string };
    }
  | {
      op: 'oauth-popup';
      payload: { url: string };
    }
  | {
      op: 'oauth-route';
      payload: Record<string, never>;
    }
  | {
      op: 'silent-renew';
      payload: { providerId: string };
    }
  | {
      op: 'capture-camera';
      payload: CameraCaptureRequest;
    }
  | { op: 'enumerate-media-devices'; payload?: undefined }
  | {
      op: 'hear-capture';
      payload: {
        lang?: string;
        timeoutMs?: number;
        deviceId?: string;
        engine?: 'auto' | 'builtin' | 'enhanced';
      };
    }
  | { op: 'hear-transcribe'; payload: { bytes: ArrayBuffer; lang?: string } }
  | { op: 'hear-status'; payload?: undefined }
  | { op: 'hear-warmup'; payload?: undefined }
  | {
      op: 'tray-reset';
      payload?: undefined;
    }
  | {
      op: 'tray-webhook-rotate';
      payload?: undefined;
    }
  | {
      op: 'tray-webhook-revoke';
      payload: { webhookId: string };
    }
  | {
      op: 'tray-open-preview';
      payload: {
        entryPath: string;
        servedRoot: string;
        bridge: boolean;
        noBridge: boolean;

        maxTabs?: number;
        quiet?: boolean;
        webhookId?: string;
        ttlMs?: number;
        snapshotFiles?: Array<{ path: string; content: Uint8Array; mime: string }>;
      };
    }
  | {
      op: 'tray-revoke-preview';
      payload: { previewToken: string };
    }
  | {
      op: 'tray-list-previews';
      payload?: undefined;
    }
  | {
      op: 'tray-mint-biscotto';
      payload: {
        label: string;
        ttlMs?: number;
        gates?: {
          message: FollowerBiscottoGate;
          tool: FollowerBiscottoGate;
        };
      };
    }
  | {
      op: 'tray-revoke-biscotto';
      payload: { id: string };
    }
  | {
      op: 'tray-list-biscotti';
      payload?: undefined;
    }
  | {
      op: 'tray-preview-logs';
      payload: { previewToken?: string };
    }
  | {
      op: 'tray-preview-truncate';
      payload: { previewToken?: string };
    }
  | {
      op: 'tray-leave';
      payload: { workerBaseUrl: string | null; requestId?: string };
    }
  | {
      op: 'tray-join';
      payload: { joinUrl: string; requestId?: string };
    }
  | {
      op: 'tray-exec';
      payload: {
        runtimeId: string;
        command: string;
        cwd?: string;
        env?: Record<string, string>;
        execToken: string;
        timeoutMs?: number;

        stdin?: string;
      };
    }
  | {
      op: 'tray-exec-signal';
      payload: { execToken: string };
    }
  | {
      op: 'slicc-attach';
      payload: { joinUrl: string; name?: string; connectTimeoutMs?: number };
    }
  | {
      op: 'slicc-detach';
      payload: { name: string };
    }
  | {
      op: 'slicc-list';
      payload: undefined;
    }
  | {
      op: 'slicc-prompt';
      payload: {
        name: string;
        text: string;
        runToken: string;
        steer?: boolean;
        timeoutMs?: number;
      };
    }
  | {
      op: 'slicc-exec';
      payload: {
        name: string;
        command: string;
        runToken: string;
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;

        stdin?: string;
      };
    }
  | {
      op: 'slicc-watch';
      payload: {
        name: string;
        runToken: string;
        durationMs: number;
        scoopJid?: string;
        untilIdle?: boolean;
      };
    }
  | {
      op: 'slicc-cancel';
      payload: { runToken: string };
    }
  | {
      op: 'oauth-extras-set';
      payload: { providerId: string; domains: string[] };
    }
  | {
      op: 'save-oauth-accounts';
      payload: { accountsJson: string };
    }
  | { op: 'usb-list'; payload?: undefined }
  | { op: 'usb-request'; payload: { filters: UsbDeviceFilter[] } }
  | { op: 'usb-device-info'; payload: { handle: string } }
  | { op: 'usb-open'; payload: { handle: string } }
  | { op: 'usb-close'; payload: { handle: string } }
  | { op: 'usb-select-configuration'; payload: { handle: string; configurationValue: number } }
  | { op: 'usb-claim-interface'; payload: { handle: string; interfaceNumber: number } }
  | { op: 'usb-release-interface'; payload: { handle: string; interfaceNumber: number } }
  | {
      op: 'usb-control-transfer-in';
      payload: { handle: string; setup: UsbControlSetup; length: number };
    }
  | {
      op: 'usb-control-transfer-out';
      payload: { handle: string; setup: UsbControlSetup; bytes: ArrayBuffer };
    }
  | { op: 'usb-transfer-in'; payload: { handle: string; endpointNumber: number; length: number } }
  | {
      op: 'usb-transfer-out';
      payload: { handle: string; endpointNumber: number; bytes: ArrayBuffer };
    }
  | { op: 'usb-reset'; payload: { handle: string } }
  | {
      op: 'usb-clear-halt';
      payload: { handle: string; direction: 'in' | 'out'; endpointNumber: number };
    }
  | { op: 'hid-list'; payload?: undefined }
  | { op: 'hid-request'; payload: { filters: HidDeviceFilter[] } }
  | { op: 'hid-device-info'; payload: { handle: string } }
  | { op: 'hid-open'; payload: { handle: string } }
  | { op: 'hid-close'; payload: { handle: string } }
  | { op: 'hid-send-report'; payload: { handle: string; reportId: number; bytes: ArrayBuffer } }
  | {
      op: 'hid-send-feature-report';
      payload: { handle: string; reportId: number; bytes: ArrayBuffer };
    }
  | { op: 'hid-receive-feature-report'; payload: { handle: string; reportId: number } }
  | { op: 'hid-subscribe-input-reports'; payload: { handle: string } }
  | { op: 'hid-unsubscribe-input-reports'; payload: { handle: string } }
  | { op: 'serial-list'; payload?: undefined }
  | { op: 'serial-request'; payload: { filters: SerialFilter[] } }
  | { op: 'serial-device-info'; payload: { handle: string } }
  | { op: 'serial-open'; payload: { handle: string; options: SerialOpenOptions } }
  | { op: 'serial-close'; payload: { handle: string } }
  | {
      op: 'serial-read';
      payload: { handle: string; maxBytes?: number; until?: ArrayBuffer; timeoutMs?: number };
    }
  | { op: 'serial-write'; payload: { handle: string; bytes: ArrayBuffer } }
  | { op: 'serial-get-signals'; payload: { handle: string } }
  | { op: 'serial-set-signals'; payload: { handle: string; signals: SerialOutputSignals } }
  | { op: 'esptool-chip-info'; payload: { handle: string; baudRate: number } }
  | { op: 'esptool-read-mac'; payload: { handle: string; baudRate: number } }
  | { op: 'esptool-erase-flash'; payload: { handle: string; baudRate: number } }
  | {
      op: 'esptool-flash';
      payload: {
        handle: string;
        baudRate: number;
        eraseAll: boolean;
        segments: Array<{ address: number; bytes: ArrayBuffer }>;
      };
    }
  | {
      op: 'esptool-read-flash';
      payload: { handle: string; baudRate: number; address: number; size: number };
    }
  | {
      op: 'esptool-read-reg';
      payload: { handle: string; baudRate: number; address: number };
    }
  | { op: 'esptool-flash-id'; payload: { handle: string; baudRate: number } }
  | {
      op: 'esptool-erase-region';
      payload: { handle: string; baudRate: number; address: number; size: number };
    }
  | { op: 'esptool-run'; payload: { handle: string; baudRate: number } }
  | {
      op: 'cherry-emit';
      payload: { runtimeId: string; name: string; detail?: unknown };
    }
  | {
      op: 'list-remote-targets';
      payload?: undefined;
    }
  | {
      op: 'remote-cdp-send';
      payload: {
        runtimeId: string;
        localTargetId: string;
        method: string;
        params?: CDPPayload;
        sessionId?: string;

        timeout?: number;
      };
    }
  | {
      op: 'remote-cdp-subscribe';
      payload: { runtimeId: string; localTargetId: string; event: string };
    }
  | {
      op: 'remote-cdp-unsubscribe';
      payload: { runtimeId: string; localTargetId: string; event: string };
    }
  | {
      op: 'remote-cdp-detach';
      payload: { runtimeId: string; localTargetId: string };
    }
  | {
      op: 'remote-open-tab';
      payload: { runtimeId: string; url: string };
    }
  | {
      op: 'proxied-fetch';
      payload: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string | Uint8Array;
      };
    }
  | {
      op: 'sudo-request';
      payload: { request: SudoRequest; mode?: 'resolve' | 'tray-first' };
    }
  | {
      op: 'secrets-bridge';
      // biome-ignore lint/plugin: the fields are whatever the named SW secrets handler declares; the bridge relays them without inspecting.
      payload: { type: string; payload?: Record<string, unknown> };
    }
  | {
      op: 'mount-sign-and-forward';
      payload: {
        type: 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward';
        envelope: unknown;
      };
    }
  | {
      op: 'permission-request';
      payload: {
        kinds: PermissionRpcKind[];
        description: string;
        heading?: string;
        grantLabel?: string;
        cancelLabel?: string;

        skipIfGranted?: boolean;
      };
    }
  | {
      op: 'secret-request';
      payload: SecretRequest;
    }
  | {
      op: 'theme-apply';
      payload: { themeJson?: string; action: 'apply' | 'reset' };
    }
  | {
      op: 'layout-apply';
      payload:
        | { kind: 'set'; tree: DockTreeSpecLike }
        | { kind: 'chat'; zone: DockZoneName }
        | { kind: 'open'; surfaceId: string; zone: DockZoneName }
        | { kind: 'close'; surfaceId: string }
        | { kind: 'move'; surfaceId: string; zone: DockZoneName }
        | { kind: 'size'; surfaceId: string; size: SurfaceSizeSpecLike }
        | { kind: 'reset' }
        | { kind: 'load'; name: string }
        | { kind: 'save'; name: string; protected: boolean }
        | { kind: 'delete'; name: string }
        | { kind: 'docs' }
        | { kind: 'panels' }
        | { kind: 'show'; panelId: string }
        | { kind: 'hide'; panelId: string };
    };

export interface PanelRpcResults {
  'page-info': { origin: string; href: string; title: string };
  screencapture: { bytes: ArrayBuffer; width: number; height: number; mimeType: string };
  'speak-text': { done: true };
  'list-voices': {
    voices: Array<{ name: string; lang: string; default: boolean; onDevice: boolean }>;
  };
  'speak-status': KokoroRpcStatus;
  'speak-warmup': KokoroRpcStatus;
  'synthesize-to-wav': { bytes: ArrayBuffer };
  'play-audio': { done: true };
  'play-chime': { done: true };
  'clipboard-read-text': { text: string };
  'clipboard-write-text': { done: true };
  'clipboard-write-image': { done: true };
  'window-open': { opened: boolean };
  'oauth-popup': { redirectUrl: string | null; error?: string };
  'oauth-route': { delegate: boolean };
  'silent-renew': { accessToken: string | null };
  'capture-camera': CameraCaptureResult;
  'enumerate-media-devices': {
    videoinputs: Array<{ deviceId: string; label: string; groupId?: string }>;
    audioinputs: Array<{ deviceId: string; label: string; groupId?: string }>;
  };
  'hear-capture': { transcript: string; engine: 'builtin' | 'enhanced' };
  'hear-transcribe': { transcript: string; engine: 'builtin' | 'enhanced' };
  'hear-status': HearRpcStatus;
  'hear-warmup': HearRpcStatus;
  'tray-reset': LeaderTrayRuntimeStatus;
  'tray-webhook-rotate': { webhookUrl: string };
  'tray-webhook-revoke': { ok: true };
  'tray-open-preview': { url: string; pushed: number; previewToken: string };
  'tray-revoke-preview': { revoked: boolean; webhookId?: string };
  'tray-list-previews': {
    previews: Array<{
      previewToken: string;
      url: string;
      servedRoot: string;
      entryPath: string;
      allowLive: boolean;
      createdAt: string;
      mode?: 'live' | 'persistent';
      expiresAt?: string;
    }>;
  };
  'tray-mint-biscotto': {
    id: string;

    url: string;
    label: string;
    expiresAt?: string;
    gates: {
      message: FollowerBiscottoGate;
      tool: FollowerBiscottoGate;
    };
  };
  'tray-revoke-biscotto': {
    id: string;
    active: boolean;
    revokedAt?: string;

    evicted?: boolean;
  };
  'tray-list-biscotti': {
    biscotti: Array<{
      id: string;
      label: string;
      createdAt: string;
      expiresAt?: string;
      revokedAt?: string;
      lastSeenAt?: string;
      active: boolean;
      gates: {
        message: FollowerBiscottoGate;
        tool: FollowerBiscottoGate;
      };
    }>;
  };
  'tray-preview-logs': {
    lifecycleRecords: Array<{
      timestamp: string;
      lifecycle: 'connected' | 'disconnected';
      connId: string;
      previewToken?: string;
      origin?: string;
      userAgent?: string;
      connectedAt?: string;
      reason?: string;
      announced: boolean;
    }>;
  };
  'tray-preview-truncate': { cleared: number; rearmed: number };
  'tray-leave': TrayLeaveResult;
  'tray-join': { joinUrl: string };
  'tray-exec': { stdout: string; stderr: string; exitCode: number; error?: string };
  'tray-exec-signal': { ok: true };
  'slicc-attach': SidecarAttachmentInfo;
  'slicc-detach': { detached: boolean };
  'slicc-list': { attachments: SidecarAttachmentInfo[] };
  'slicc-prompt': SidecarRunResult;
  'slicc-exec': SidecarRunResult;
  'slicc-watch': SidecarRunResult;
  'slicc-cancel': { ok: true };
  'oauth-extras-set': { storeAfter: OAuthExtraDomainsStore };
  'save-oauth-accounts': { storedJson: string };
  'usb-list': { devices: UsbDeviceInfo[] };
  'usb-request': { device: UsbDeviceInfo };
  'usb-device-info': { device: UsbDeviceInfo };
  'usb-open': { done: true };
  'usb-close': { done: true };
  'usb-select-configuration': { done: true };
  'usb-claim-interface': { done: true };
  'usb-release-interface': { done: true };
  'usb-control-transfer-in': { status: string; bytes: ArrayBuffer };
  'usb-control-transfer-out': { status: string; bytesWritten: number };
  'usb-transfer-in': { status: string; bytes: ArrayBuffer };
  'usb-transfer-out': { status: string; bytesWritten: number };
  'usb-reset': { done: true };
  'usb-clear-halt': { done: true };
  'hid-list': { devices: HidDeviceInfo[] };
  'hid-request': { devices: HidDeviceInfo[] };
  'hid-device-info': { device: HidDeviceInfo };
  'hid-open': { done: true };
  'hid-close': { done: true };
  'hid-send-report': { done: true };
  'hid-send-feature-report': { done: true };
  'hid-receive-feature-report': { reportId: number; bytes: ArrayBuffer };
  'hid-subscribe-input-reports': { done: true };
  'hid-unsubscribe-input-reports': { done: true };
  'serial-list': { devices: SerialDeviceInfo[] };
  'serial-request': { device: SerialDeviceInfo };
  'serial-device-info': { device: SerialDeviceInfo };
  'serial-open': { done: true };
  'serial-close': { done: true };
  'serial-read': { bytes: ArrayBuffer };
  'serial-write': { bytesWritten: number };
  'serial-get-signals': { signals: SerialInputSignals };
  'serial-set-signals': { done: true };
  'esptool-chip-info': EsptoolChipInfo;
  'esptool-read-mac': { mac: string };
  'esptool-erase-flash': { done: true };
  'esptool-flash': { done: true };
  'esptool-read-flash': { bytes: ArrayBuffer };
  'esptool-read-reg': { value: number };
  'esptool-flash-id': EsptoolFlashId;
  'esptool-erase-region': { done: true };
  'esptool-run': { done: true };
  'cherry-emit': { delivered: boolean };
  'list-remote-targets': {
    targets: Array<{ targetId: string; title: string; url: string }>;
  };
  'remote-cdp-send': CDPPayload;
  'remote-cdp-subscribe': { ok: true };
  'remote-cdp-unsubscribe': { ok: true };
  'remote-cdp-detach': { ok: true };
  'remote-open-tab': { targetId: string };
  'proxied-fetch': {
    head: { status: number; statusText: string; headers: Record<string, string> };
    body: ArrayBuffer;
  };
  'permission-request': { grants: PermissionRpcGrant[] };

  'secret-request': SecretRequestOutcome;
  'sudo-request': { decision: SudoDecision; handled?: boolean };
  'secrets-bridge': { response: unknown };
  'mount-sign-and-forward': { response: SignAndForwardReply };
  'theme-apply': { applied: string | null };

  'layout-apply': { applied: boolean; output?: string; error?: string };
}

export type PermissionRpcKind =
  | 'camera'
  | 'microphone'
  | 'screenshare'
  | 'usb'
  | 'hid'
  | 'serial'
  | 'filesystem';

export type PermissionRpcGrant =
  | { kind: 'usb'; handle: string }
  | { kind: 'hid'; handle: string }
  | { kind: 'serial'; handle: string }
  | { kind: 'filesystem'; idbKey: string; dirName: string }
  | { kind: 'camera' | 'microphone' | 'screenshare'; ok: true };

export interface HearRpcStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  loaded?: number;
  total?: number;
  etaSeconds?: number | null;
}

export interface KokoroRpcStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  loaded?: number;
  total?: number;
  etaSeconds?: number | null;
}

export interface EsptoolChipInfo {
  chip: string;

  description: string;

  features: string[];

  crystalMHz: number;

  mac: string;
}

export interface EsptoolFlashId {
  flashId: number;

  manufacturer: number;

  device: number;

  flashSize: string | null;
}

export interface EsptoolProgressEventPayload {
  handle: string;
  line: string;
}

export interface HidInputReportEventPayload {
  handle: string;
  reportId: number;
  bytes: ArrayBuffer;
}

export type PanelRpcOp = PanelRpcRequest['op'];
export type PanelRpcPayloadFor<O extends PanelRpcOp> = Extract<
  PanelRpcRequest,
  { op: O }
>['payload'];
export type PanelRpcResultFor<O extends PanelRpcOp> = PanelRpcResults[O];

export type PanelRpcResultsCoverage = { [K in PanelRpcOp]: PanelRpcResults[K] };

interface PanelRpcRequestMsg {
  type: 'panel-rpc-request';
  id: string;
  op: PanelRpcOp;
  payload: unknown;
}

interface PanelRpcResponseMsg {
  type: 'panel-rpc-response';
  id: string;
  result?: unknown;
  error?: string;
}

interface PanelRpcEventMsg {
  type: 'panel-rpc-event';
  channel: string;
  payload: unknown;
}

export interface RemoteCdpEventPayload {
  runtimeId: string;
  localTargetId: string;
  method: string;
  params?: CDPPayload;
}

export interface PanelRpcPushMsg {
  type: 'panel-rpc-push';
  op: 'remote-cdp-event';
  payload: RemoteCdpEventPayload;
}

export interface PanelRpcClient {
  call<O extends PanelRpcOp>(
    op: O,
    payload: PanelRpcPayloadFor<O>,
    opts?: { timeoutMs?: number }
  ): Promise<PanelRpcResultFor<O>>;

  onEvent(channel: string, handler: (payload: unknown) => void): () => void;

  registerPushTarget(key: string, handler: (payload: RemoteCdpEventPayload) => void): void;

  unregisterPushTarget(key: string): void;

  dispose(): void;
}

export function createPanelRpcClient(options: { instanceId?: string } = {}): PanelRpcClient {
  if (typeof BroadcastChannel !== 'function') {
    return {
      call: () => Promise.reject(new Error('panel-rpc: BroadcastChannel is unavailable')),
      onEvent: () => () => {},
      registerPushTarget: () => {},
      unregisterPushTarget: () => {},
      dispose: () => {},
    };
  }

  const channelName = panelRpcChannelName(options.instanceId);
  const channel = new BroadcastChannel(channelName);
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const pushTargets = new Map<string, (payload: RemoteCdpEventPayload) => void>();

  const eventSubscribers = new Map<string, Set<(payload: unknown) => void>>();

  const handleEventMsg = (msg: PanelRpcEventMsg): void => {
    const subs = eventSubscribers.get(msg.channel);
    if (!subs) return;
    for (const handler of subs) {
      try {
        handler(msg.payload);
      } catch (err) {
        console.warn(
          `panel-rpc: event handler for '${msg.channel}' threw:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  };

  const handlePushMsg = (msg: PanelRpcPushMsg): void => {
    if (msg.op !== 'remote-cdp-event') return;
    const p = msg.payload;
    pushTargets.get(`${p.runtimeId}:${p.localTargetId}`)?.(p);
  };

  const handleResponseMsg = (msg: PanelRpcResponseMsg): void => {
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (typeof msg.error === 'string') slot.reject(new Error(msg.error));
    else slot.resolve(msg.result);
  };

  channel.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as PanelRpcResponseMsg | PanelRpcEventMsg | PanelRpcPushMsg | undefined;
    if (msg?.type === 'panel-rpc-event') handleEventMsg(msg);
    else if (msg?.type === 'panel-rpc-push') handlePushMsg(msg);
    else if (msg?.type === 'panel-rpc-response') handleResponseMsg(msg);
  });

  function onEvent(eventChannel: string, handler: (payload: unknown) => void): () => void {
    let subs = eventSubscribers.get(eventChannel);
    if (!subs) {
      subs = new Set();
      eventSubscribers.set(eventChannel, subs);
    }
    subs.add(handler);
    return () => {
      const set = eventSubscribers.get(eventChannel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) eventSubscribers.delete(eventChannel);
    };
  }

  function call<O extends PanelRpcOp>(
    op: O,
    payload: PanelRpcPayloadFor<O>,
    opts: { timeoutMs?: number } = {}
  ): Promise<PanelRpcResultFor<O>> {
    const id = newRequestId();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<PanelRpcResultFor<O>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`panel-rpc: op '${op}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const req: PanelRpcRequestMsg = { type: 'panel-rpc-request', id, op, payload };
      channel.postMessage(req);
    });
  }

  function registerPushTarget(
    key: string,
    handler: (payload: RemoteCdpEventPayload) => void
  ): void {
    pushTargets.set(key, handler);
  }

  function unregisterPushTarget(key: string): void {
    pushTargets.delete(key);
  }

  function dispose(): void {
    for (const [, slot] of pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error('panel-rpc: client disposed'));
    }
    pending.clear();
    eventSubscribers.clear();
    pushTargets.clear();
    try {
      channel.close();
    } catch {}
  }

  return { call, onEvent, registerPushTarget, unregisterPushTarget, dispose };
}

export interface PanelRpcEventEmitter {
  emit(channel: string, payload: unknown): void;

  dispose(): void;
}

export function createPanelRpcEventEmitter(
  options: { instanceId?: string } = {}
): PanelRpcEventEmitter {
  if (typeof BroadcastChannel !== 'function') {
    return { emit: () => {}, dispose: () => {} };
  }
  const channel = new BroadcastChannel(panelRpcChannelName(options.instanceId));
  return {
    emit(eventChannel: string, payload: unknown): void {
      const msg: PanelRpcEventMsg = { type: 'panel-rpc-event', channel: eventChannel, payload };
      try {
        channel.postMessage(msg);
      } catch (err) {
        console.warn(
          `panel-rpc: failed to emit event '${eventChannel}':`,
          err instanceof Error ? err.message : String(err)
        );
      }
    },
    dispose(): void {
      try {
        channel.close();
      } catch {}
    },
  };
}

export type PanelRpcHandlers = {
  [O in PanelRpcOp]?: (
    payload: PanelRpcPayloadFor<O>
  ) => Promise<PanelRpcResultFor<O>> | PanelRpcResultFor<O>;
};

export function installPanelRpcHandler(options: {
  handlers: PanelRpcHandlers;
  instanceId?: string;
}): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(panelRpcChannelName(options.instanceId));

  const respond = (id: string, result?: unknown, error?: string): void => {
    const msg: PanelRpcResponseMsg = { type: 'panel-rpc-response', id };
    if (error !== undefined) msg.error = error;
    else msg.result = result;
    try {
      channel.postMessage(msg);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`panel-rpc: failed to post response for id=${id}: ${reason}`);
    }
  };

  const listener = async (event: MessageEvent): Promise<void> => {
    const msg = event.data as PanelRpcRequestMsg | undefined;
    if (msg?.type !== 'panel-rpc-request') return;
    const handler = (options.handlers as Record<string, ((p: unknown) => unknown) | undefined>)[
      msg.op
    ];
    if (!handler) {
      respond(msg.id, undefined, `panel-rpc: no handler for op '${msg.op}'`);
      return;
    }
    try {
      const result = await handler(msg.payload);
      respond(msg.id, result);
    } catch (err) {
      respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
    }
  };

  channel.addEventListener('message', listener as (ev: MessageEvent) => void);

  return () => {
    channel.removeEventListener('message', listener as (ev: MessageEvent) => void);
    try {
      channel.close();
    } catch {}
  };
}

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `prpc-${crypto.randomUUID()}`;
  }
  return `prpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getPanelRpcClient(): PanelRpcClient | null {
  const g = globalThis as unknown as { __slicc_panelRpc?: PanelRpcClient };
  return g.__slicc_panelRpc ?? null;
}

export function hasLocalDom(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}
