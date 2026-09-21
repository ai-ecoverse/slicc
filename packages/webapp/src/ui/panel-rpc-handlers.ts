/**
 * Page-side handlers for the panel-RPC bridge defined in
 * `kernel/panel-rpc.ts`. The kernel worker has no DOM, no
 * `mediaDevices`, no `clipboard`, and no `speechSynthesis`/`AudioContext`
 * — these handlers run in the page context and execute the actual
 * browser-API calls on behalf of worker-side supplemental commands.
 *
 * Wired from `mainStandaloneWorker` after the orchestrator boot
 * handshake; the extension float doesn't use this module because its
 * offscreen document already has a DOM.
 *
 * Factories live in `ui/panel-rpc/`; this file is the composition root.
 */

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

/**
 * Options threaded into the handler factory. Each callback is optional
 * — the corresponding op rejects with a clear error when the callback
 * is absent (e.g. tray-reset before the leader tray has booted).
 */
export interface StandalonePanelRpcHandlerOptions {
  /**
   * Reset the page-side leader tray and return the post-reset status.
   * Wired by `mainStandaloneWorker` to `pageLeaderTray.reset()` when
   * a leader is active; left undefined otherwise.
   */
  resetTray?: () => Promise<LeaderTrayRuntimeStatus>;
  /**
   * Rotate the cone's stable webhook capability (#2812) and return the new
   * webhook base URL. Wired by `mainStandaloneWorker` to
   * `pageLeaderTray.leader.rotateWebhook()` when a leader is active; left
   * undefined otherwise.
   */
  rotateWebhook?: () => Promise<{ webhookUrl: string }>;
  revokeWebhook?: (webhookId: string) => Promise<void>;
  /**
   * Mint a preview URL via the worker, broadcast preview.open to all
   * followers, and return the URL + follower count. Wired by
   * `mainStandaloneWorker` to a closure that reads `pageLeaderTray.currentLeaderSync`
   * + the active session's trayId/controllerToken. Throws when no
   * active leader. Standalone uses this path because `serve` lives in
   * the kernel worker but `LeaderSyncManager` lives on the page; the
   * extension path uses the in-realm `setPreviewMinter` hook instead.
   */
  /**
   * Mint / revoke / list biscotto guest seats. Standalone uses this path for
   * the same reason `serve` does: the `biscotto` command runs in the kernel
   * worker, which has no controller token — the page-side leader holds it.
   *
   * The payload and result types are declared once, in `panel-rpc.ts`, and
   * referenced here rather than restated, so a field cannot exist on one side
   * of this boundary and not the other.
   */
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
  /**
   * Revoke a previously-minted preview token. Wired by
   * `mainStandaloneWorker` to a closure that reads the active
   * session's trayId/controllerToken and calls the worker HTTP API.
   * Throws when no active leader.
   */
  revokePreview?: (payload: {
    previewToken: string;
  }) => Promise<{ revoked: boolean; webhookId?: string }>;
  /**
   * List active preview records on the tray. Wired by
   * `mainStandaloneWorker` to a closure that reads the active
   * session's trayId/controllerToken and calls the worker HTTP API.
   * Throws when no active leader.
   */
  listPreviews?: () => Promise<PanelRpcResults['tray-list-previews']>;
  /** Read preview lifecycle records held by the page-side leader. */
  getPreviewLifecycleRecords?: (previewToken?: string) => PanelRpcResults['tray-preview-logs'];
  /** Clear lifecycle records and re-arm the matching announcement latch. */
  truncatePreviewLifecycleRecords?: (
    previewToken?: string
  ) => PanelRpcResults['tray-preview-truncate'];
  /**
   * Leave the page-side leader/follower tray (or switch role to leader
   * on the supplied worker URL). Wired by `mainStandaloneWorker` to the
   * `slicc:tray-leave` event handler so `host leave` in the kernel
   * worker drives the same teardown path as the avatar popover.
   * Returns the previous mode and the post-leave worker URL so the
   * shell can render an informative message.
   */
  leaveTray?: (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }) => Promise<PanelRpcResults['tray-leave']> | PanelRpcResults['tray-leave'];
  /**
   * Join (follow) a tray page-side. Wired by `setupStandalonePanelRpc`
   * to persist the join URL and dispatch `slicc:tray-join` so `host join`
   * in the kernel worker drives the same follower-start path as the
   * avatar popover / dialog. Left undefined where the page can't host a
   * follower; the handler then throws.
   */
  joinTray?: (opts: {
    joinUrl: string;
    requestId?: string;
  }) => Promise<PanelRpcResults['tray-join']> | PanelRpcResults['tray-join'];
  /**
   * Emit an event on the panel-RPC event channel back to worker
   * subscribers. Wired by `mainStandaloneWorker` to a
   * `createPanelRpcEventEmitter` instance so the `hid` command's
   * `watch` subscription receives input reports as the page-side
   * device emits them. Left undefined in tests / contexts without an
   * emitter; the subscribe handler then drops reports silently.
   */
  emitEvent?: (channel: string, payload: unknown) => void;
  /**
   * Push a `cherry.slicc_event` (cone → host page) out through the
   * page-side LeaderSyncManager. Wired by `mainStandaloneWorker` to
   * `pageLeaderTray.sync.emitCherrySliccEvent(...)`; the worker-side
   * `cherry-emit` command bridges here because the leader tray's WebRTC
   * data channels live on the page. Returns `true` when the message was
   * sent, `false` when the owning follower is not connected.
   */
  emitCherrySliccEvent?: (runtimeId: string, name: string, detail?: unknown) => boolean;
  /**
   * Run a command on a connected follower for the worker-side `ssh` command.
   * Wired to the page-side `LeaderSyncManager.execOnRemote(...)` (the WebRTC
   * data channels live on the page). Resolves with the buffered result. Absent
   * when no leader tray is active — the `tray-exec` handler then rejects.
   */
  execOnRemote?: (payload: {
    runtimeId: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    execToken: string;
    timeoutMs?: number;
    stdin?: string;
  }) => Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }>;
  /**
   * Drive `computer.native.*` on a ScreenCaptureKit follower. Wired to
   * `LeaderSyncManager.captureNativeComputer` / `inputNativeComputer`.
   */
  computerNative?: (
    payload: PanelRpcPayloadFor<'tray-computer-native'>
  ) => Promise<PanelRpcResults['tray-computer-native']>;
  /** Cancel an in-flight {@link StandalonePanelRpcHandlerOptions.execOnRemote}, keyed by execToken. */
  /**
   * The page-side `slicc` sidecar registry — attachments to OTHER SLICC
   * leaders, held while this instance keeps leading its own tray. Wired by
   * `setupStandalonePanelRpc`. Absent where the page can't hold a sidecar
   * (tests, `uiOnly` shells); the `slicc-*` handlers then throw.
   *
   * Note the asymmetry with `execOnRemote` above: that one needs a live LEADER
   * tray, this one needs no tray of our own at all.
   */
  sliccSidecar?: SidecarRegistryLike;
  signalRemoteExec?: (payload: { execToken: string }) => void;
  /**
   * Return the remote (follower) browser targets known to the page-side
   * BrowserAPI. `mainStandaloneWorker` wires this unconditionally to
   * `browser.listAllTargets()`; it returns local-only (no composite
   * targetIds) until a leader tray is active, and the `list-remote-targets`
   * handler filters to composite ids. The worker's BrowserAPI has no
   * trayTargetProvider, so it can't call listAllTargets() itself — this
   * bridges the gap. Optional so other host wirings (tests) may omit it.
   */
  listRemoteTargets?: () => Promise<PageInfo[]> | PageInfo[];
  /**
   * Page-side remote-CDP bridge backing the `remote-cdp-*` /
   * `remote-open-tab` ops. Lets the worker BrowserAPI *drive* federated
   * tray/cherry targets by tunneling each CDP op to the page-side
   * `RemoteCDPTransport`. Wired by `mainStandaloneWorker`; absent in
   * environments without a leader tray (the ops then reject clearly).
   * See issue #848.
   */
  remoteCdp?: RemoteCdpPageBridge;
  /**
   * Resolve the currently-mounted leader `<slicc-permissions>` element
   * for the `permission-request` op. Lazy accessor (not a direct
   * reference) so the resolver reads the live registry binding — the
   * surface may mount after handler installation. Returning `null` lets
   * the op reject with a clear "permission surface unavailable" error.
   */
  getPermissionsSurface?: () => SliccPermissions | null;
  /**
   * Run the interactive OAuth hop on a follower instead of here (#1915) —
   * by driving that follower's browser where possible, else via a popup on
   * its page. Resolves `{ delegated: false }` when the login belongs on this
   * tab (the leader's own human sent the last message, or no capable follower
   * is connected) and the caller falls back to the local popup.
   */
  delegateOAuthLogin?: (
    url: string
  ) => Promise<
    { delegated: false } | { delegated: true; redirectUrl: string | null; error?: string }
  >;
  /**
   * Whether an OAuth login started right now would be delegated. Providers
   * consult this BEFORE building the authorize URL, because a delegated flow
   * needs a callback that comes back to the follower rather than the
   * leader's loopback.
   */
  shouldDelegateOAuth?: () => Promise<boolean> | boolean;
}

/**
 * The subset of `SidecarRegistry` (`scoops/tray-sidecar.ts`) these handlers
 * drive. Structural on purpose: this module is imported by JSDOM tests that
 * have no WebRTC, so it must not pull in the real registry — and a fake is a
 * plain object literal rather than a class stub.
 */
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

/**
 * Build a record of handlers suitable for `installPanelRpcHandler`.
 * Pure factory so the handler set is easy to test under JSDOM.
 */
export function createStandalonePanelRpcHandlers(
  options: StandalonePanelRpcHandlerOptions = {}
): PanelRpcHandlers {
  // Active `hid watch` subscriptions, keyed by device handle. Each maps
  // to the page-side `inputreport` unsubscribe so the matching
  // `hid-unsubscribe-input-reports` op (or a re-subscribe) tears it down.
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
