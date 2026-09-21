import type { SliccPermissions } from '@slicc/webcomponents';

import type { PageInfo } from '../cdp/types.js';
import type { PanelRpcHandlers, PanelRpcPayloadFor, PanelRpcResults } from '../kernel/panel-rpc.js';
import type { LeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import type {
  SidecarAttachmentInfo,
  SidecarPromptOptions,
  SidecarRunOptions,
  SidecarRunResult,
  SidecarWatchOptions,
} from '../scoops/tray-sidecar.js';
import {
  buildMountBridgeHandler,
  buildProxiedFetchHandler,
  buildSecretRequestHandler,
  buildSecretsBridgeHandler,
  buildSudoRequestHandler,
} from './panel-rpc/bridge-handlers.js';
import {
  buildEsptoolHandlers,
  buildHidHandlers,
  buildSerialHandlers,
  buildUsbHandlers,
} from './panel-rpc/device-handlers.js';
import {
  buildClipboardCaptureHandlers,
  buildHearHandlers,
  buildPageAudioHandlers,
  ensureScreenSessionEndedRelay,
} from './panel-rpc/media-handlers.js';
import {
  buildPermissionRequestHandler,
  buildRemoteCdpHandlers,
  buildSliccSidecarHandlers,
} from './panel-rpc/misc-handlers.js';
import { buildTrayOauthHandlers } from './panel-rpc/oauth-handlers.js';
import {
  buildComputerTabHandlers,
  buildLayoutHandler,
  buildThemeHandler,
} from './panel-rpc/ui-handlers.js';
import type { RemoteCdpPageBridge } from './remote-cdp-page-bridge.js';

export interface StandalonePanelRpcHandlerOptions {
  resetTray?: () => Promise<LeaderTrayRuntimeStatus>;

  rotateWebhook?: () => Promise<{ webhookUrl: string }>;
  revokeWebhook?: (webhookId: string) => Promise<void>;

  mintBiscotto?: (
    payload: PanelRpcPayloadFor<'tray-mint-biscotto'>
  ) => Promise<PanelRpcResults['tray-mint-biscotto']>;
  revokeBiscotto?: (
    payload: PanelRpcPayloadFor<'tray-revoke-biscotto'>
  ) => Promise<PanelRpcResults['tray-revoke-biscotto']>;
  listBiscotti?: () => Promise<PanelRpcResults['tray-list-biscotti']>;
  mintPreview?: (payload: {
    entryPath: string;
    servedRoot: string;
    bridge: boolean;
    noBridge: boolean;
    maxTabs?: number;
    quiet?: boolean;
    webhookId?: string;
    ttlMs?: number;
    snapshotFiles?: Array<{ path: string; content: Uint8Array; mime: string }>;
  }) => Promise<{ url: string; pushed: number; previewToken: string }>;

  revokePreview?: (payload: {
    previewToken: string;
  }) => Promise<{ revoked: boolean; webhookId?: string }>;

  listPreviews?: () => Promise<PanelRpcResults['tray-list-previews']>;

  getPreviewLifecycleRecords?: (previewToken?: string) => PanelRpcResults['tray-preview-logs'];

  truncatePreviewLifecycleRecords?: (
    previewToken?: string
  ) => PanelRpcResults['tray-preview-truncate'];

  leaveTray?: (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }) => Promise<PanelRpcResults['tray-leave']> | PanelRpcResults['tray-leave'];

  joinTray?: (opts: {
    joinUrl: string;
    requestId?: string;
  }) => Promise<PanelRpcResults['tray-join']> | PanelRpcResults['tray-join'];

  emitEvent?: (channel: string, payload: unknown) => void;

  emitCherrySliccEvent?: (runtimeId: string, name: string, detail?: unknown) => boolean;

  execOnRemote?: (payload: {
    runtimeId: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    execToken: string;
    timeoutMs?: number;
    stdin?: string;
  }) => Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }>;

  computerNative?: (
    payload: PanelRpcPayloadFor<'tray-computer-native'>
  ) => Promise<PanelRpcResults['tray-computer-native']>;

  sliccSidecar?: SidecarRegistryLike;
  signalRemoteExec?: (payload: { execToken: string }) => void;

  listRemoteTargets?: () => Promise<PageInfo[]> | PageInfo[];

  remoteCdp?: RemoteCdpPageBridge;

  getPermissionsSurface?: () => SliccPermissions | null;

  delegateOAuthLogin?: (
    url: string
  ) => Promise<
    { delegated: false } | { delegated: true; redirectUrl: string | null; error?: string }
  >;

  shouldDelegateOAuth?: () => Promise<boolean> | boolean;
}

export interface SidecarRegistryLike {
  attach(opts: {
    joinUrl: string;
    name?: string;
    connectTimeoutMs?: number;
  }): Promise<SidecarAttachmentInfo>;
  detach(name: string): boolean;
  list(): SidecarAttachmentInfo[];
  prompt(name: string, text: string, options?: SidecarPromptOptions): Promise<SidecarRunResult>;
  exec(
    name: string,
    command: string,
    options?: SidecarRunOptions & { cwd?: string; env?: Record<string, string>; stdin?: string }
  ): Promise<SidecarRunResult>;
  watch(name: string, options: SidecarWatchOptions): Promise<SidecarRunResult>;
}

export function createStandalonePanelRpcHandlers(
  options: StandalonePanelRpcHandlerOptions = {}
): PanelRpcHandlers {
  const hidSubscriptions = new Map<string, () => void>();
  ensureScreenSessionEndedRelay(options.emitEvent);

  return {
    ...buildPageAudioHandlers(),
    ...buildClipboardCaptureHandlers(options),
    ...buildHearHandlers(),
    ...buildTrayOauthHandlers(options),
    ...buildSliccSidecarHandlers(options),
    ...buildUsbHandlers(options),
    ...buildHidHandlers(options, hidSubscriptions),
    ...buildSerialHandlers(),
    ...buildEsptoolHandlers(options),
    ...buildRemoteCdpHandlers(options),
    ...buildPermissionRequestHandler(options),
    ...buildProxiedFetchHandler(),
    ...buildSudoRequestHandler(),
    ...buildSecretRequestHandler(),
    ...buildSecretsBridgeHandler(),
    ...buildMountBridgeHandler(),
    ...buildThemeHandler(),
    ...buildLayoutHandler(),
    ...buildComputerTabHandlers(),
  };
}

export type {
  CameraCaptureRequest,
  CameraCaptureResult,
} from '../kernel/panel-rpc-camera-types.js';
export { captureCamera } from './panel-rpc/media-handlers.js';
