/**
 * `page-follower-tray.ts` — page-side boot wiring for the multi-browser
 * sync follower role.
 *
 * Mirror of {@link startPageLeaderTray} for the joining browser. When the
 * user opens a join URL (or has one stored under the
 * `TRAY_JOIN_STORAGE_KEY` constant — `slicc.trayJoinUrl` — in
 * localStorage), this helper:
 *
 *   1. Starts a `FollowerTrayManager` with automatic reconnect (via
 *      `startFollowerWithAutoReconnect`) that establishes the WebRTC
 *      data channel to the leader.
 *   2. On each successful connection, constructs a `FollowerSyncManager`
 *      that wraps the data channel and implements `AgentHandle`.
 *   3. Wires the follower sync into the page's chat panel as its agent
 *      handle, so user input from the chat goes to the leader's
 *      orchestrator instead of the local kernel-worker orchestrator.
 *   4. Periodically advertises the follower's local browser targets to
 *      the leader (every 5s by default) so the leader's federated CDP
 *      registry stays current.
 *
 * Like {@link startPageLeaderTray}, this module has no UI imports — the
 * caller wires every page-side dependency via flat callbacks.
 *
 * Spec: `docs/superpowers/specs/2026-05-17-multi-browser-sync-page-side-restoration.md`.
 */

import { isSliccAppUrl } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { MessageAttachment } from '../core/attachments.js';
import { ThrottledErrorTracker } from '../scoops/throttled-error-tracker.js';
import { setFollowerTrayRuntimeStatus } from '../scoops/tray-follower-status.js';
import {
  FollowerSyncManager,
  type FollowerSyncManagerOptions,
} from '../scoops/tray-follower-sync.js';
import type { ScoopSummary, SprinkleSummary } from '../scoops/tray-sync-protocol.js';
import {
  CHERRY_RUNTIME_TAG,
  type RemoteTargetInfo,
  type TraySyncCapabilities,
} from '../scoops/tray-sync-protocol.js';
import {
  type FollowerAutoReconnectHandle,
  type FollowerTrayConnection,
  startFollowerWithAutoReconnect,
  type TrayPeerConnectionFactory,
} from '../scoops/tray-webrtc.js';
import { canonicalRuntimeId } from './runtime-identity.js';
import { SprinkleFollowerController } from './sprinkle-follower-controller.js';
import type { SprinkleAddOptions } from './sprinkle-manager.js';
import type { AgentHandle, ChatMessage } from './types.js';

const log = createLogger('page-follower-tray');

export { CHERRY_RUNTIME_TAG } from '../scoops/tray-sync-protocol.js';

/**
 * Force the follower runtime status to inactive on teardown. When a reconnect
 * loop has already given up, `cancel()` is a no-op and the page-side status
 * lingers at `error`. That status is mirrored to the `slicc.followerTrayStatus`
 * shim, so without this reset the worker-side `host` reports a phantom
 * `status: follower (error)` after a `host leave` or a switch to leading.
 * Unconditional and idempotent — a live manager's own stop() also sets
 * inactive; this guarantees it for the gave-up path too.
 */
function resetFollowerRuntimeStatus(): void {
  setFollowerTrayRuntimeStatus({
    state: 'inactive',
    joinUrl: null,
    trayId: null,
    error: null,
    lastPingTime: null,
    reconnectAttempts: 0,
    attachAttempts: 0,
    lastAttachCode: null,
    connectingSince: null,
    lastError: null,
  });
}

/** Hand the freshly wired sync to the page surfaces that consume it. */
function activateFollowerSync(
  options: Pick<
    StartPageFollowerTrayOptions,
    | 'browserAPI'
    | 'setChatAgent'
    | 'onForwardingToggle'
    | 'onConnectionChange'
    | 'getSelectedScoopJid'
  >,
  sync: FollowerSyncManager
): void {
  options.browserAPI.setTrayTargetProvider(sync);
  options.setChatAgent(sync);
  options.onForwardingToggle?.(true);
  options.onConnectionChange?.(true);
  sync.requestSnapshot(options.getSelectedScoopJid?.() ?? undefined);
}

/**
 * Capabilities this follower advertises on `hello`.
 *
 * A cherry follower lends a host page, not a browser: it must never claim to
 * be a teleport-capable browser host. `oauthPopup` tracks whether the caller
 * actually wired an interactive-login handler — one source of truth, so the
 * leader can never delegate a login to a float that would drop it.
 */
export function helloCapabilitiesForRuntime(
  runtime: string | undefined,
  canHostOAuthPopup = false
): TraySyncCapabilities | undefined {
  if (runtime === CHERRY_RUNTIME_TAG) return undefined;
  return { browser: true, ...(canHostOAuthPopup ? { oauthPopup: true } : {}) };
}

/**
 * Shape the page's local browser targets for advertisement to the leader.
 *
 * A cherry follower (`runtime === CHERRY_RUNTIME_TAG`) lends a cooperative host
 * page, not a real browser tab: it can never serve `Network.*`, so every target
 * it advertises is tagged `kind: 'cherry'` with `capabilities.network = false`.
 * That metadata is what lets the leader keep cherry out of flows it cannot
 * satisfy — `canRuntimeOpenTab` (tab.open) reads `kind`, and
 * `getBestFollowerForTeleport` / `selectTeleportPool` read `capabilities.network`.
 * `navigate`/`screenshot` are advisory: the host SDK is the real authority and
 * gates each CDP domain itself, and the iframe never learns the host's exact
 * grants — only `network` (always false) and `kind` drive leader selection here.
 *
 * Non-cherry runtimes advertise `kind: 'browser'` with full capabilities:
 * their targets ride a real CDP transport, so `Network.*` (cookie teleport),
 * navigation, and screenshots all work. Explicit capabilities let the leader
 * treat them as authoritative instead of guessing from the target kind.
 */
export function buildAdvertisedTargets(
  pages: { targetId: string; title: string; url: string }[],
  runtime: string
): RemoteTargetInfo[] {
  // Never advertise our own app shell. Its URL carries `bridgeToken` (and the
  // join URL), so federating it would publish a capability to every peer and
  // offer a "tab" whose only effect is booting a second UI. See
  // `isSliccAppUrl`; the iOS mirror is `BrowserTargets.isSliccAppPage`.
  const selfOrigins =
    typeof location !== 'undefined' && location.origin ? [location.origin] : undefined;
  const advertisable = pages.filter((p) => !isSliccAppUrl(p.url, { selfOrigins }));
  if (runtime !== CHERRY_RUNTIME_TAG) {
    return advertisable.map((p) => ({
      targetId: p.targetId,
      title: p.title,
      url: p.url,
      kind: 'browser' as const,
      capabilities: { navigate: true, network: true, screenshot: true },
    }));
  }
  return advertisable.map((p) => ({
    targetId: p.targetId,
    title: p.title,
    url: p.url,
    kind: 'cherry' as const,
    capabilities: { navigate: true, network: false, screenshot: true },
  }));
}

export interface StartPageFollowerTrayOptions {
  /** The leader's join URL (from the `TRAY_JOIN_STORAGE_KEY` constant — `slicc.trayJoinUrl` — in localStorage). */
  joinUrl: string;

  /** Tray runtime tag (default 'slicc-standalone'). Cherry passes 'slicc-cherry' so leader selection can distinguish it. */
  runtime?: string;

  /**
   * Whether this follower has a CDP surface worth advertising to the leader.
   * When false the follower keeps handshake + transport + chat sync but never
   * enumerates or advertises targets.
   *
   * Must reflect whether a local CDP surface actually EXISTS — not which float
   * is running. A follower without one that still polls will dial
   * `getDefaultCdpUrl()` (= `wss://<page-origin>/cdp`) on a 5s loop forever;
   * on a hosted origin that path returns the SPA fallback, so the socket can
   * never open and the loop never ends.
   *
   * Callers: `wc-follower.ts` derives this via `followerAdvertisesCdpTargets`.
   */
  advertisesCdpTargets?: boolean;
  /**
   * The leader's tray-wide target registry changed. Drives the follower's own
   * browser rail (`wireWcFollowerBrowser`), which lists every tab in the tray
   * so the user can pull one here.
   */
  onTargetsUpdated?: (targets: import('../scoops/tray-sync-protocol.js').TrayTargetEntry[]) => void;
  /**
   * Show a leader-delegated OAuth login here (#1915). Wiring this is what
   * advertises `capabilities.oauthPopup`, so only floats that can really
   * prompt a human should pass it.
   */
  onOAuthPopupRequest?: (url: string, signal: AbortSignal) => Promise<string | null>;

  // --- FollowerSyncManager callbacks (forwarded directly) ---
  /** Replace the follower's chat panel with the snapshot from the leader. */
  onSnapshot: (messages: ChatMessage[], scoopJid: string) => void;
  /** Append a user message (local echo or another follower's) to the chat panel. */
  onUserMessage: (
    text: string,
    messageId: string,
    scoopJid: string,
    attachments?: MessageAttachment[]
  ) => void;
  /** Update processing from the leader's scoop status. scoopJid is absent for legacy leaders. */
  onStatus: (scoopStatus: string, scoopJid?: string) => void;
  /**
   * Forward a leader-sent `cherry.slicc_event` (cone → host page) onward. Only
   * the cherry boot path wires this — it routes the event to the host SDK via
   * the iframe's `CherryHostTransport.emitSliccEventToHost`. Omitted by ordinary
   * followers, where the event has no host page to reach.
   */
  onCherrySliccEvent?: (name: string, detail?: unknown) => void;
  /**
   * Notified when the leader updates the scoop list (nav bar / scoop picker).
   * Optional — when omitted, the follower still syncs chat fully, it just has
   * no scoop switcher UI to update.
   */
  onScoopsList?: (scoops: ScoopSummary[], activeScoopJid: string) => void;
  /** Receive the leader's selectable model catalog. */
  onModelsList?: FollowerSyncManagerOptions['onModelsList'];
  /** Receive the leader's active model and selected-scoop thinking state. */
  onModelState?: FollowerSyncManagerOptions['onModelState'];
  /**
   * Render a sudo approval the leader delegated to this follower's human
   * (headless leader, or the human is driving from here — issue #2062).
   * Forwarded verbatim to `FollowerSyncManager`; when unset the follower
   * replies with a denial, so the gate stays fail-closed.
   */
  onSudoApprovalRequest?: FollowerSyncManagerOptions['onSudoApprovalRequest'];

  // --- Page-side wiring callbacks ---
  /**
   * Install the freshly-constructed `FollowerSyncManager` as the chat
   * panel's agent handle. The follower sync implements `AgentHandle`, so
   * `chat.sendMessage` from the panel now forwards to the leader over
   * WebRTC instead of to the local orchestrator. Wired to
   * `layout.panels.chat.setAgent` by the caller.
   */
  setChatAgent: (agent: AgentHandle) => void;

  // --- BrowserAPI for federated target advertisement ---
  browserAPI: BrowserAPI;

  /**
   * Called with `true` once a follower connection is live and `false`
   * on detach/stop. The worker-backed follower (standalone leader page +
   * extension offscreen) wires this to `client.sendSetFollowerForwarding(enabled)`
   * so the kernel worker forwards navigate licks while connected. The no-kernel
   * follower (`wc-follower.ts`) leaves it unset and forwards licks page-side via
   * `follower-navigate-watcher.ts` instead.
   */
  onForwardingToggle?: (enabled: boolean) => void;

  /**
   * Called with `true` once a follower connection is live and `false` on
   * detach. Distinct from `onForwardingToggle` (which is about lick
   * forwarding): this drives connection UX — e.g. the no-kernel follower mount
   * disables its composer + shows "Connecting to leader…" until `true`.
   */
  onConnectionChange?: (connected: boolean) => void;
  /** Preserve the viewed scoop when a fresh reconnect sync requests its snapshot. */
  getSelectedScoopJid?: () => string | null;
  /**
   * Called with `true` when the leader stops answering keepalive pings while
   * the data channel is still open, and `false` when it answers again. The
   * connection survives a stall untouched, so this is deliberately NOT routed
   * through `onConnectionChange`: a mount must be able to say "the leader is
   * busy" without claiming a disconnect (and, for cherry, without emitting
   * `slicc.follower.disconnected` to the host page).
   */
  onLeaderStalled?: (stalled: boolean) => void;
  /**
   * Called when auto-reconnect gives up (no more attempts). The mount surfaces
   * a "couldn't reach the leader" state. `lastError` is the final failure.
   */
  onGaveUp?: (lastError: unknown) => void;
  /**
   * Called when the tray hub reports this join URL was superseded by a fresh
   * one (the leader abandoned this tray and minted a new one on resume). The
   * connection recovers transparently — this callback exists so the caller
   * can persist the replacement (e.g. `TRAY_JOIN_STORAGE_KEY`) before a
   * future reload would otherwise resurrect the dead URL.
   */
  onJoinUrlChanged?: (newJoinUrl: string) => void;

  // --- Sprinkle sync wiring (optional) ---
  /**
   * Add a sprinkle panel to the host layout. When omitted, the follower simply
   * does not surface the leader's sprinkles — chat sync still works fully.
   * Matches the signature of `SprinkleManagerCallbacks.addSprinkle` so callers
   * can pass through the same layout callbacks used by the leader's
   * `SprinkleManager`.
   */
  addSprinkle?: (
    name: string,
    title: string,
    element: HTMLElement,
    zone?: string,
    options?: SprinkleAddOptions
  ) => void;
  /** Remove a sprinkle panel from the host layout. */
  removeSprinkle?: (name: string) => void;
  /**
   * Notified when the leader updates the sprinkle list. The host layout can
   * use this to update e.g. a sprinkle picker without subscribing to the
   * follower sync directly. Optional — `SprinkleFollowerController` already
   * handles open-state mirroring.
   */
  onSprinklesList?: (sprinkles: SprinkleSummary[]) => void;
  /**
   * Optional sprinkle `open(path)` override. The no-kernel follower
   * (`wc-follower.ts`) has no page VFS responder, so relative paths would 404
   * on `/preview/*`; it passes a guard that only opens absolute URLs. Other
   * followers (with a kernel/VFS) leave it unset and use the default.
   */
  onOpen?: (path: string) => void;

  // --- Test hooks ---
  /** @internal Override fetch (defaults to plain `fetch`). */
  _fetchImpl?: typeof fetch;
  /** @internal Override the WebRTC peer-connection factory. */
  _peerConnectionFactory?: TrayPeerConnectionFactory;
  /** @internal Override the target-advertisement interval in ms (default 5000). */
  _refreshIntervalMs?: number;
  /** @internal Override the per-attempt sleep (used by reconnect backoff in tests). */
  _sleep?: (ms: number) => Promise<void>;
}

export interface PageFollowerTrayHandle {
  /**
   * Cancel the reconnect loop, close the active follower sync, and stop
   * advertising local targets.
   */
  stop(): void;
  /**
   * The currently-active follower sync, or `null` between connections
   * (initial connect pending or in the middle of a reconnect).
   * Exposed for testing.
   */
  readonly currentSync: FollowerSyncManager | null;
}

/** Apply a leader theme from the UI layer without adding a scoops → UI import. */
export function applyFollowerLeaderTheme(themeJson: string | null): void {
  void import('./theme-engine.js')
    .then(
      ({ importTheme, saveCustomTheme, setActiveTheme, clearActiveTheme, applyThemeOverrides }) => {
        if (!themeJson) {
          clearActiveTheme();
        } else {
          const theme = importTheme(themeJson);
          saveCustomTheme(theme);
          setActiveTheme(theme.id);
        }
        applyThemeOverrides();
      }
    )
    .catch((err) => log.error('Failed to apply leader theme', { err }));
}

/**
 * Construct + start the follower tray subsystem on the page. Returns a
 * handle that the caller can hold for shutdown.
 *
 * Caller is responsible for gating on `joinUrl` presence — when no join
 * URL is stored, this helper is not invoked at all (the leader path runs
 * via {@link startPageLeaderTray} instead).
 */
export function startPageFollowerTray(
  options: StartPageFollowerTrayOptions
): PageFollowerTrayHandle {
  const refreshIntervalMs = options._refreshIntervalMs ?? 5000;

  let activeSync: FollowerSyncManager | null = null;
  let activeSprinkleController: SprinkleFollowerController | null = null;
  let targetRefreshInterval: ReturnType<typeof setInterval> | null = null;
  let reconnectHandle: FollowerAutoReconnectHandle | null = null;

  // `emitDisconnect` lets the terminal gave-up path tear down without firing
  // onConnectionChange(false): onGaveUp() runs immediately after and sets the
  // final placeholder, so emitting the transient "disconnected" state first
  // would momentarily flip the composer back to "Connecting…".
  const detachSync = (emitDisconnect = true): void => {
    if (targetRefreshInterval) {
      clearInterval(targetRefreshInterval);
      targetRefreshInterval = null;
    }
    if (activeSprinkleController) {
      activeSprinkleController.dispose();
      activeSprinkleController = null;
    }
    if (!activeSync) return;
    options.onForwardingToggle?.(false);
    if (emitDisconnect) options.onConnectionChange?.(false);
    options.browserAPI.setTrayTargetProvider(null);
    activeSync.close();
    activeSync = null;
  };

  const wireFollowerSync = (connection: FollowerTrayConnection): void => {
    detachSync();
    const runtimeId = canonicalRuntimeId(connection.bootstrapId);

    // The sprinkle controller (if the caller wired sprinkle layout callbacks)
    // is constructed lazily here so it shares the lifecycle of this sync
    // instance — a transient WebRTC drop tears it down and a reconnect rebuilds
    // it against the new channel.
    let sprinkleController: SprinkleFollowerController | null = null;

    const sync = new FollowerSyncManager(connection.channel, {
      browserTransport: options.browserAPI.getTransport(),
      browserAPI: options.browserAPI,
      helloCapabilities: helloCapabilitiesForRuntime(
        options.runtime,
        !!options.onOAuthPopupRequest
      ),
      onOAuthPopupRequest: options.onOAuthPopupRequest,
      onSnapshot: options.onSnapshot,
      onUserMessage: options.onUserMessage,
      onStatus: options.onStatus,
      onCherrySliccEvent: options.onCherrySliccEvent,
      onTargetsUpdated: options.onTargetsUpdated,
      onScoopsList: options.onScoopsList,
      onModelsList: options.onModelsList,
      onModelState: options.onModelState,
      onThemeApply: applyFollowerLeaderTheme,
      onSudoApprovalRequest: options.onSudoApprovalRequest,
      selfRuntimeId: runtimeId,
      onTargetsChanged: () => void refreshTargets(),
      onSprinklesList: (sprinkles) => {
        options.onSprinklesList?.(sprinkles);
        void sprinkleController?.updateAvailable(sprinkles);
      },
      onSprinkleUpdate: (name, data) => sprinkleController?.handleSprinkleUpdate(name, data),
      onSprinkleReloaded: (name) => void sprinkleController?.handleSprinkleReloaded(name),
      onLeaderStalled: (stalled) => options.onLeaderStalled?.(stalled),
      onDisconnect: (reason) => {
        log.warn('Follower sync disconnected', { reason });
        detachSync();
      },
    });

    if (options.addSprinkle && options.removeSprinkle) {
      sprinkleController = new SprinkleFollowerController({
        sync,
        addSprinkle: options.addSprinkle,
        removeSprinkle: options.removeSprinkle,
        open: options.onOpen,
      });
      activeSprinkleController = sprinkleController;
    }

    // CDP target listing — throttled error path. Shared with
    // `page-leader-tray.ts` via `scoops/throttled-error-tracker.ts`;
    // see that file for the throttle/recovery contract.
    const cdpThrottle = new ThrottledErrorTracker(log, {
      failureMessage: 'Follower CDP target listing failed (best-effort, throttled)',
      recoveryMessage: 'Follower CDP target listing recovered (stable for debounce window)',
    });
    const refreshTargets = async (): Promise<void> => {
      if (options.advertisesCdpTargets === false) return; // no local CDP surface to advertise
      let pages: Awaited<ReturnType<typeof options.browserAPI.listPages>>;
      try {
        pages = await options.browserAPI.listPages();
      } catch (err) {
        cdpThrottle.reportFailure(err);
        return;
      }
      // A reconnect mid-flight may have swapped `activeSync` — bail in
      // that case so we don't advertise this connection's runtimeId
      // against the new sync (or vice versa).
      if (activeSync !== sync) return;
      cdpThrottle.reportSuccess();
      try {
        sync.advertiseTargets(
          buildAdvertisedTargets(pages, options.runtime ?? 'slicc-standalone'),
          runtimeId
        );
      } catch (err) {
        log.error('Follower target advertisement broadcast failed (sync.advertiseTargets threw)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    activeSync = sync;
    activateFollowerSync(options, sync);

    if (options.advertisesCdpTargets !== false) {
      targetRefreshInterval = setInterval(() => void refreshTargets(), refreshIntervalMs);
      void refreshTargets();
    }

    log.info('Follower sync wired', { trayId: connection.trayId });
  };

  reconnectHandle = startFollowerWithAutoReconnect(
    {
      joinUrl: options.joinUrl,
      runtime: options.runtime ?? 'slicc-standalone',
      fetchImpl: options._fetchImpl,
      peerConnectionFactory: options._peerConnectionFactory,
      sleep: options._sleep,
      onJoinUrlChanged: options.onJoinUrlChanged,
    },
    {
      onConnected: wireFollowerSync,
      onReconnecting: (attempt) => {
        log.info('Follower reconnecting', { attempt });
      },
      onGaveUp: (lastError) => {
        log.warn('Follower reconnect gave up', { lastError });
        detachSync(false);
        options.onGaveUp?.(lastError);
      },
      sleep: options._sleep,
    }
  );

  return {
    stop() {
      detachSync();
      reconnectHandle?.cancel();
      reconnectHandle = null;
      // Force the follower runtime status to inactive on teardown. When a
      // reconnect loop has already given up, `activeManager` is null, so the
      // `cancel()` above is a no-op and the page-side status lingers at
      // `error`. That status is mirrored to the `slicc.followerTrayStatus`
      // shim, so without this reset the worker-side `host` would report a
      // phantom `status: follower (error)` after a `host leave` or a switch to
      // leading. `stop()` is the teardown boundary, so clearing here is
      // unconditional and idempotent (a live manager's own stop() also sets
      // inactive; this just guarantees it for the gave-up path too).
      resetFollowerRuntimeStatus();
    },
    get currentSync() {
      return activeSync;
    },
  };
}
