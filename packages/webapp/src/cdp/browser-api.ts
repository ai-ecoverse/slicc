/**
 * High-level Playwright-inspired browser API built on CDPClient.
 *
 * Provides: connect, listPages, navigate, screenshot, evaluate,
 * click, type, waitForSelector, getAccessibilityTree.
 */

import type { TrayTargetEntry } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import { CDPClient } from './cdp-client.js';
import { HarRecorder } from './har-recorder.js';
import { INJECTED_ARIA_SNAPSHOT_SCRIPT } from './injected-aria-snapshot.js';
import { normalizeAccessibilityText } from './normalize-accessibility-text.js';
import type { CDPTransport } from './transport.js';
import type {
  AccessibilityNode,
  BoundingBox,
  CDPConnectOptions,
  EvaluateOptions,
  FrameEvaluateOptions,
  FrameInfo,
  PageInfo,
  TargetInfo,
  WaitForSelectorOptions,
} from './types.js';

/** Read PNG width from IHDR (bytes 16–19 after the 8-byte signature). */
function pngWidth(base64: string): number {
  try {
    const bin = atob(base64.slice(0, 48));
    return (
      ((bin.charCodeAt(16) << 24) |
        (bin.charCodeAt(17) << 16) |
        (bin.charCodeAt(18) << 8) |
        bin.charCodeAt(19)) >>>
      0
    );
  } catch {
    return 0;
  }
}

/**
 * Provider of remote tray targets and transport factory.
 * Set via `setTrayTargetProvider()` to enable remote target support.
 */
export interface TrayTargetProvider {
  getTargets(): TrayTargetEntry[];
  createRemoteTransport?(runtimeId: string, localTargetId: string): CDPTransport;
  removeRemoteTransport?(runtimeId: string, localTargetId: string): void;
  /** Open a new tab on a remote runtime. Returns the composite targetId. */
  openRemoteTab?(runtimeId: string, url: string): Promise<string>;
}

const FALLBACK_CDP_URL = 'ws://localhost:5710/cdp';
const log = createLogger('browser-api');

export function getDefaultCdpUrl(
  locationLike: Pick<Location, 'protocol' | 'host'> | null = typeof window !== 'undefined'
    ? window.location
    : null
): string {
  if (!locationLike?.host) return FALLBACK_CDP_URL;
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/cdp`;
}

/**
 * A CDP message payload (params or result) — a protocol-defined JSON object
 * probed key by key at each use site. Named so the shape is stated once
 * instead of an untyped string-keyed bag per site.
 */
type CdpPayload = { [key: string]: unknown };

/**
 * Per-target emulation override, re-applied on every fresh attach so a
 * sibling driver switching tabs cannot reset it (see setViewportOverride).
 */
interface ViewportOverride {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  /** Set for mobile emulation so sites serve their mobile layout. */
  userAgent?: string;
}

export class BrowserAPI {
  private client: CDPTransport;
  private localClient: CDPTransport; // preserved original when using remote transport
  private sessionId: string | null = null;
  private attachedTargetId: string | null = null;
  private trayTargetProvider: TrayTargetProvider | null = null;
  private remoteTargetInfo: { runtimeId: string; localTargetId: string } | null = null;
  private _frameContextCache = new Map<string, number>();
  private _mainWorldContextCache = new Map<string, number>();
  private _tabLock: Promise<void> = Promise.resolve();
  private _viewportOverrides = new Map<string, ViewportOverride>();
  private _tabLockQueueDepth = 0;
  private _tabLockTotalWaitMs = 0;
  private _tabLockAcquisitions = 0;
  private _onSessionChange?: ((sessionId: string, transport: CDPTransport) => void) | undefined;
  /**
   * Last-used connect options (url + protocols) captured on the first
   * successful (or attempted) `connect()`. Lazy reconnects via
   * `ensureConnected()` / `ensureLocalConnected()` reuse this so the
   * bridge URL + subprotocol survive a transport drop — without it, a
   * thin-bridge reconnect would fall back to `getDefaultCdpUrl()` and
   * try to hit `wss://<hosted-leader-host>/cdp`, which doesn't exist.
   */
  private _lastConnectOptions: Partial<CDPConnectOptions> | null = null;
  /**
   * Fired once when the local CDP client is superseded by a newer client
   * (another SLICC tab/window on the same standalone instance). Boot wires
   * this to a user-facing banner. Standalone-only — extension `DebuggerClient`
   * has no `/cdp` proxy, so it never supersedes.
   */
  private supersededHandler: (() => void) | null = null;
  private supersededNotified = false;
  private readonly handleJavaScriptDialogOpening = (params: CdpPayload): void => {
    void this.dismissJavaScriptDialog(params);
  };
  private async dismissJavaScriptDialog(params: CdpPayload): Promise<void> {
    const sessionId =
      typeof params['sessionId'] === 'string' ? (params['sessionId'] as string) : this.sessionId;
    if (!sessionId) return;

    try {
      await this.client.send('Page.handleJavaScriptDialog', { accept: false }, sessionId, 5000);
      log.warn('Auto-dismissed unexpected JavaScript dialog', {
        sessionId,
        type: params['type'],
        message: params['message'],
        url: params['url'],
      });
    } catch (error) {
      log.warn('Failed to auto-dismiss JavaScript dialog', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private readonly handleExecutionContextCreated = (params: CdpPayload): void => {
    const eventSessionId = params['sessionId'];
    if (typeof eventSessionId === 'string' && eventSessionId !== this.sessionId) return;
    const context = params['context'] as
      | { id?: number; auxData?: { frameId?: string; isDefault?: boolean } }
      | undefined;
    const frameId = context?.auxData?.frameId;
    if (context?.auxData?.isDefault === true && frameId && typeof context.id === 'number') {
      this._mainWorldContextCache.set(frameId, context.id);
    }
  };
  private readonly handleExecutionContextDestroyed = (params: CdpPayload): void => {
    const eventSessionId = params['sessionId'];
    if (typeof eventSessionId === 'string' && eventSessionId !== this.sessionId) return;
    const contextId = params['executionContextId'];
    if (typeof contextId !== 'number') return;
    for (const [frameId, cachedId] of this._mainWorldContextCache) {
      if (cachedId === contextId) this._mainWorldContextCache.delete(frameId);
    }
  };
  private readonly handleExecutionContextsCleared = (params: CdpPayload): void => {
    const eventSessionId = params['sessionId'];
    if (typeof eventSessionId === 'string' && eventSessionId !== this.sessionId) return;
    this._mainWorldContextCache.clear();
  };

  constructor(client?: CDPTransport) {
    this.client = client ?? new CDPClient();
    this.localClient = this.client;
    this.addDialogListener(this.client);
    this.addExecutionContextListeners(this.client);
  }

  /**
   * Get the underlying CDP transport.
   * Used by HarRecorder to subscribe to network events.
   */
  getTransport(): CDPTransport {
    return this.client;
  }

  /**
   * Construct a {@link HarRecorder} bound to a CDP transport.
   * Lets the shell-layer `record` handler create a recorder without importing
   * the cdp-layer class directly (which would invert the layer stack).
   *
   * Pass the `transport` that produced the recording's session ID so the
   * recorder stays bound to that CDP channel even if a concurrent operation
   * swaps `this.client` in the meantime; defaults to the current transport.
   */
  createHarRecorder(fs: VirtualFS, transport: CDPTransport = this.client): HarRecorder {
    return new HarRecorder(transport, fs);
  }

  /**
   * Register a callback invoked when a new CDP session is established via
   * `attachToPage()`.  The callback receives the CDP session ID and the
   * active transport, allowing subscribers (e.g. BshWatchdog) to track
   * transport swaps and know that `Page.enable` has already been sent.
   *
   * The callback is **not** invoked when `attachToPage()` returns early
   * because the requested target is already attached (no new session).
   *
   * Pass `undefined` to clear a previously registered callback.
   */
  setSessionChangeCallback(
    cb: ((sessionId: string, transport: CDPTransport) => void) | undefined
  ): void {
    this._onSessionChange = cb;
  }

  /**
   * Get the current session ID (if attached to a target).
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Get the currently attached target ID.
   */
  getAttachedTargetId(): string | null {
    return this.attachedTargetId;
  }

  /**
   * Execute an operation on a specific tab with exclusive access.
   * Serializes all tab operations — only one tab can be attached at a time.
   * Handles local and remote (tray) targets transparently.
   */
  async withTab<T>(targetId: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
    let release: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this._tabLock;
    this._tabLock = next;
    this._tabLockQueueDepth += 1;
    const waitStart = Date.now();
    await prev;
    this._tabLockTotalWaitMs += Date.now() - waitStart;
    this._tabLockAcquisitions += 1;
    try {
      const sessionId = await this.attachToPage(targetId);
      return await fn(sessionId);
    } finally {
      this._tabLockQueueDepth -= 1;
      release!();
    }
  }

  /**
   * Contention metrics for the tab lock that serializes all `withTab` work.
   *
   * `queueDepth` counts callers currently holding or waiting for the lock,
   * `totalWaitMs` accumulates time spent queued across all callers, and
   * `acquisitions` counts completed lock grants. Callers snapshot the stats
   * before and after an operation to attribute contention observed while it
   * ran (e.g. `playwright-cli` surfaces it on stderr so concurrent agents can
   * back off deliberately instead of guessing).
   */
  getTabLockStats(): { queueDepth: number; totalWaitMs: number; acquisitions: number } {
    return {
      queueDepth: this._tabLockQueueDepth,
      totalWaitMs: this._tabLockTotalWaitMs,
      acquisitions: this._tabLockAcquisitions,
    };
  }

  /**
   * Apply a viewport emulation override to a tab and remember it per target.
   *
   * CDP device-metrics overrides live on the CDP *session*, but `attachToPage`
   * creates a fresh session whenever a caller re-attaches after another tab was
   * attached in between — so with concurrent drivers, a plain
   * `Emulation.setDeviceMetricsOverride` silently evaporates and screenshots
   * get captured at whatever width the window happens to have. Recording the
   * override per target lets {@link attachToPage} re-apply it on every fresh
   * session, making a tab's viewport stable no matter which driver measured it
   * last. Cleared by {@link closePage}.
   */
  async setViewportOverride(
    targetId: string,
    width: number,
    height: number,
    options?: { deviceScaleFactor?: number; mobile?: boolean; userAgent?: string }
  ): Promise<void> {
    const sessionId = await this.attachToPage(targetId);
    const vp: ViewportOverride = {
      width,
      height,
      deviceScaleFactor: options?.deviceScaleFactor ?? 1,
      mobile: options?.mobile ?? false,
      ...(options?.userAgent !== undefined && { userAgent: options.userAgent }),
    };
    await this.applyViewportOverride(vp, sessionId);
    this._viewportOverrides.set(targetId, vp);
  }

  /** Send the recorded metrics (and UA, for mobile emulation) to a session. */
  private async applyViewportOverride(vp: ViewportOverride, sessionId: string): Promise<void> {
    await this.client.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.deviceScaleFactor,
        mobile: vp.mobile,
      },
      sessionId
    );
    if (vp.userAgent !== undefined) {
      await this.client.send(
        'Emulation.setUserAgentOverride',
        { userAgent: vp.userAgent },
        sessionId
      );
    }
  }

  /** Re-apply a recorded viewport override after a fresh attach (best-effort). */
  private async reapplyViewportOverride(targetId: string, sessionId: string): Promise<void> {
    const vp = this._viewportOverrides.get(targetId);
    if (!vp) return;
    try {
      await this.applyViewportOverride(vp, sessionId);
    } catch (err) {
      log.warn('Failed to re-apply viewport override on re-attach', {
        targetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Set a provider of remote tray targets.
   * When set, listAllTargets() includes remote targets and attachToPage()
   * can attach to remote targets using the "{runtimeId}:{localTargetId}" format.
   */
  setTrayTargetProvider(provider: TrayTargetProvider | null): void {
    this.trayTargetProvider = provider;
  }

  /**
   * List all pages — local + remote tray targets.
   * Remote targets have targetId format "{runtimeId}:{localTargetId}".
   * Deduplicates leader-owned registry entries when they mirror a local page.
   */
  async listAllTargets(): Promise<PageInfo[]> {
    const local = await this.listPages();
    if (!this.trayTargetProvider) return local;

    const shouldDeduplicateLeaderTargets = !this.remoteTargetInfo;
    const localIds = new Set(local.map((p) => p.targetId));
    const remoteEntries = this.trayTargetProvider.getTargets();
    const remote: PageInfo[] = remoteEntries
      .filter(
        (t) =>
          !shouldDeduplicateLeaderTargets ||
          !(t.runtimeId === 'leader' && localIds.has(t.localTargetId))
      )
      .map((t) => ({
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        kind: t.kind,
        capabilities: t.capabilities,
      }));

    return [...local, ...remote];
  }

  /**
   * Connect to the CDP proxy.
   * `ExtensionBridgeTransport` (thin extension) ignores these options.
   */
  async connect(options?: Partial<CDPConnectOptions>): Promise<void> {
    // Capture the connect options BEFORE attempting the connection so
    // subsequent lazy reconnects via `ensureConnected()` can replay the
    // same bridge URL + subprotocol even when the very first connect
    // racing against bridge startup failed.
    this._lastConnectOptions = options ? { ...options } : {};
    await this.client.connect({
      url: options?.url ?? getDefaultCdpUrl(),
      timeout: options?.timeout,
      ...(options?.protocols !== undefined ? { protocols: options.protocols } : {}),
    });
    // A successful (re)connect re-arms the supersede notification so a later
    // eviction can surface again.
    this.supersededNotified = false;
  }

  /**
   * Record the connect options WITHOUT dialing the bridge.
   *
   * The Electron follower-overlay boot path deliberately skips the eager
   * `connect()` so multiple overlay tabs don't all race for the single-client
   * `/cdp` proxy slot. But a follower overlay that later acts as a tray
   * follower must still federate its local page targets, which goes through
   * `listPages()` → `ensureConnected()`. Without a captured
   * `_lastConnectOptions`, that lazy connect falls back to
   * `getDefaultCdpUrl()` — the hosted-leader origin, which has no `/cdp` — so
   * the listing fails and nothing is advertised to the leader. Priming the
   * options here lets the on-demand connect reach the LOCAL bridge instead.
   */
  primeConnectOptions(options?: Partial<CDPConnectOptions>): void {
    this._lastConnectOptions = options ? { ...options } : {};
  }

  /**
   * Register a callback fired (once per episode) when the local CDP slot is
   * taken over by a newer client — see {@link CDP_SUPERSEDED_CLOSE_CODE}.
   * Pass `null` to clear. Boot uses this to show a banner instead of letting
   * two tabs evict each other over the single proxy slot in silence.
   */
  setCdpSupersededHandler(handler: (() => void) | null): void {
    this.supersededHandler = handler;
  }

  private notifySuperseded(): void {
    if (this.supersededNotified) return;
    this.supersededNotified = true;
    try {
      this.supersededHandler?.();
    } catch {
      // A banner failure must not break the agent's CDP path.
    }
  }

  /**
   * Create a new browser tab/target.
   * Returns the targetId of the newly created tab.
   * The tab opens in the background by default.
   * Always creates on the local browser, even when currently attached to a remote target.
   */
  async createPage(url?: string): Promise<string> {
    await this.ensureConnected();
    await this.ensureLocalConnected();
    const result = await this.localClient.send('Target.createTarget', {
      url: url ?? 'about:blank',
      background: true,
    });
    return result['targetId'] as string;
  }

  /**
   * Create a new tab on a remote runtime within the tray.
   * Requires a tray target provider with openRemoteTab support.
   * Returns the composite targetId ("{runtimeId}:{localTargetId}").
   */
  async createRemotePage(runtimeId: string, url?: string): Promise<string> {
    if (!this.trayTargetProvider?.openRemoteTab) {
      throw new Error('Remote tab opening not available (no tray target provider)');
    }
    return this.trayTargetProvider.openRemoteTab(runtimeId, url ?? 'about:blank');
  }

  /**
   * Close a browser tab/target by its targetId.
   * Handles remote tray targets by routing through RemoteCDPTransport.
   */
  async closePage(targetId: string): Promise<void> {
    await this.ensureConnected();
    this._viewportOverrides.delete(targetId);

    // Check if this is a remote tray target (format: "runtimeId:localTargetId")
    if (this.trayTargetProvider?.createRemoteTransport && targetId.includes(':')) {
      const colonIdx = targetId.indexOf(':');
      const runtimeId = targetId.substring(0, colonIdx);
      const localTargetId = targetId.substring(colonIdx + 1);

      // Trust the runtimeId:localTargetId format — don't require registry confirmation.
      {
        const remoteTransport = this.trayTargetProvider.createRemoteTransport(
          runtimeId,
          localTargetId
        );
        try {
          await remoteTransport.send('Target.closeTarget', { targetId: localTargetId });
        } finally {
          if (this.trayTargetProvider.removeRemoteTransport) {
            this.trayTargetProvider.removeRemoteTransport(runtimeId, localTargetId);
          }
        }

        // If we were attached to the target being closed, clean up
        if (this.attachedTargetId === targetId) {
          if (this.remoteTargetInfo) {
            this.setClient(this.localClient);
            this.remoteTargetInfo = null;
          }
          this.sessionId = null;
          this.attachedTargetId = null;
        }
        return;
      }
    }

    await this.localClient.send('Target.closeTarget', { targetId });

    // Clean up if we were attached to this target
    if (this.attachedTargetId === targetId) {
      this.sessionId = null;
      this.attachedTargetId = null;
    }
  }

  /**
   * Disconnect and clean up.
   */
  disconnect(): void {
    this.sessionId = null;
    this.attachedTargetId = null;
    this.client.disconnect();
  }

  /**
   * List all open pages (tabs).
   * Always queries the local browser, even when currently attached to a remote target.
   */
  async listPages(): Promise<PageInfo[]> {
    await this.ensureConnected();
    await this.ensureLocalConnected();
    const result = await this.localClient.send('Target.getTargets');
    const targets = (result['targetInfos'] as TargetInfo[]) ?? [];
    return targets
      .filter((t) => t.type === 'page')
      .map((t) => ({
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        ...(t.active ? { active: true } : {}),
      }));
  }

  /**
   * Attach to a specific page target, enabling page-level commands.
   * Returns the CDP session ID for the attached target.
   *
   * If the targetId contains a colon (format "{runtimeId}:{localTargetId}"),
   * it's treated as a remote tray target and a RemoteCDPTransport is used.
   */
  async attachToPage(targetId: string): Promise<string> {
    await this.ensureConnected();
    // Skip if already attached to this target
    if (this.sessionId && this.attachedTargetId === targetId) {
      return this.sessionId;
    }
    // Don't detach from previous target — just attach to the new one.
    // Detaching then re-attaching causes Chrome to steal window focus.

    // Invalidate cached execution context IDs from the previous target
    this._frameContextCache.clear();
    this._mainWorldContextCache.clear();

    // Check if this is a remote tray target (format: "runtimeId:localTargetId")
    if (this.trayTargetProvider?.createRemoteTransport && targetId.includes(':')) {
      const colonIdx = targetId.indexOf(':');
      const runtimeId = targetId.substring(0, colonIdx);
      const localTargetId = targetId.substring(colonIdx + 1);

      // The runtimeId:localTargetId format is a strong signal this is remote.
      // Don't require registry confirmation — the target may have just been
      // created via createRemotePage() and not yet advertised.
      {
        const remoteTransport = this.trayTargetProvider.createRemoteTransport(
          runtimeId,
          localTargetId
        );
        this.setClient(remoteTransport);
        this.remoteTargetInfo = { runtimeId, localTargetId };

        // Send attachToTarget via the remote transport
        const result = await this.client.send('Target.attachToTarget', {
          targetId: localTargetId,
          flatten: true,
        });
        this.sessionId = result['sessionId'] as string;
        this.attachedTargetId = targetId;
        await this.client.send('Page.enable', {}, this.sessionId);
        await this.reapplyViewportOverride(targetId, this.sessionId);
        this._onSessionChange?.(this.sessionId, this.client);
        return this.sessionId;
      }
    }

    // Restore local transport if we were previously attached to a remote target
    if (this.remoteTargetInfo) {
      if (this.trayTargetProvider?.removeRemoteTransport) {
        this.trayTargetProvider.removeRemoteTransport(
          this.remoteTargetInfo.runtimeId,
          this.remoteTargetInfo.localTargetId
        );
      }
      this.setClient(this.localClient);
      this.remoteTargetInfo = null;
    }
    await this.ensureLocalConnected();

    const result = await this.localClient.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    this.sessionId = result['sessionId'] as string;
    this.attachedTargetId = targetId;
    // Keep Page events available so unexpected dialogs can be auto-dismissed
    // before they stall the current CDP command.
    await this.localClient.send('Page.enable', {}, this.sessionId);
    await this.reapplyViewportOverride(targetId, this.sessionId);
    this._onSessionChange?.(this.sessionId, this.localClient);
    return this.sessionId;
  }

  /**
   * Detach from the currently attached target.
   * If attached to a remote target, restores the local transport.
   */
  async detach(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.client.send('Target.detachFromTarget', {
          sessionId: this.sessionId,
        });
      } catch {
        // Target may already be detached
      }

      // Restore local transport if we were using a remote one
      if (this.remoteTargetInfo && this.trayTargetProvider?.removeRemoteTransport) {
        this.trayTargetProvider.removeRemoteTransport(
          this.remoteTargetInfo.runtimeId,
          this.remoteTargetInfo.localTargetId
        );
        this.setClient(this.localClient);
        this.remoteTargetInfo = null;
      }

      this.sessionId = null;
      this.attachedTargetId = null;
    }
  }

  /**
   * Navigate the attached page to a URL. Waits for the load event.
   */
  async navigate(url: string): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    // Enable Page domain for lifecycle events
    await this.client.send('Page.enable', {}, this.sessionId!);

    const loadPromise = this.client.once('Page.loadEventFired');

    await this.client.send('Page.navigate', { url }, this.sessionId!);

    await loadPromise;
  }

  /**
   * Take a screenshot of the attached page.
   * Returns a base64-encoded PNG string.
   */
  /**
   * Foreground the attached page (a local tab raise, or the follower's tab
   * via the remote transport). Requires a prior `attachToPage`.
   */
  async bringToFront(): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();
    await this.client.send('Page.bringToFront', {}, this.sessionId ?? undefined);
  }

  /**
   * Foreground-fallback capture. Waking the renderer via `Page.bringToFront`
   * steals window focus — and in a capture-every-tab loop each fallback used
   * to leave the LAST captured tab in front, backgrounding SLICC (which
   * Chrome may then freeze; see docs/pitfalls.md). So: remember who held
   * focus, capture, give focus back. Restoration is best-effort and must
   * never fail the capture.
   */
  private async wakeCaptureAndRestoreFocus(params: CdpPayload): Promise<CdpPayload> {
    const captured = this.getAttachedTargetId();
    const previousFront = await this.findFocusedLocalPage(captured).catch(() => null);
    // The probe attaches to candidate pages; put the attachment back on the
    // tab being captured BEFORE fronting it, or the capture below runs on the
    // last-probed page's session and returns the wrong tab's pixels.
    if (captured) await this.attachToPage(captured);
    try {
      await this.client.send('Page.bringToFront', {}, this.sessionId!);
      return await this.client.send('Page.captureScreenshot', params, this.sessionId!);
    } finally {
      // In a finally: a retry capture that THROWS must still give focus back,
      // or a failed screenshot leaves the captured tab in front and SLICC
      // backgrounded — the exact state this helper exists to prevent.
      if (previousFront && captured) {
        try {
          await this.attachToPage(previousFront);
          await this.client.send('Page.bringToFront', {}, this.sessionId!);
          // Leave the attachment where the caller expects it.
          await this.attachToPage(captured);
        } catch {
          // The focus donor may have closed mid-capture; the capture outcome
          // is unaffected, so swallow.
        }
      }
    }
  }

  /**
   * The local page that currently holds window focus, or `null`. Probed by
   * evaluating `document.hasFocus()` per candidate — CDP exposes no focus
   * flag on targets. Uses raw `attachToPage` (never `withTab`) so a caller
   * already holding the tab lock cannot deadlock; only the rare
   * foreground-fallback path pays this cost. Remote (tray) targets are
   * skipped: their focus lives on another machine.
   */
  private async findFocusedLocalPage(excludeTargetId: string | null): Promise<string | null> {
    const pages = await this.listPages();
    for (const page of pages) {
      if (!page.targetId || page.targetId === excludeTargetId) continue;
      if (page.targetId.includes(':')) continue; // composite = remote tray target
      try {
        await this.attachToPage(page.targetId);
        const focused = await this.evaluate('document.hasFocus()');
        if (focused === true) return page.targetId;
      } catch {
        // Unattachable candidates simply are not the focused page.
      }
    }
    return null;
  }

  async screenshot(options?: {
    format?: 'png' | 'jpeg' | 'webp';
    quality?: number;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number; scale?: number };
    maxWidth?: number;
    /**
     * Whether a failed capture may retry after `Page.bringToFront` (wakes a
     * suspended renderer but STEALS WINDOW FOCUS). Default true — background
     * thumbnailing passes false so capturing never yanks focus from SLICC.
     */
    foregroundFallback?: boolean;
  }): Promise<string> {
    await this.ensureConnected();
    this.ensureAttached();

    try {
      const params: CdpPayload = {
        format: options?.format ?? 'png',
        // Only capture beyond viewport when fullPage or a clip is requested.
        // Default viewport screenshots should respect the viewport boundary.
        captureBeyondViewport: !!(options?.clip || options?.fullPage),
      };
      if (options?.quality !== undefined) params['quality'] = options.quality;

      if (options?.clip || options?.fullPage) {
        // Get CSS dimensions for full-page clip
        let cssWidth = 0;
        let cssScrollHeight = 0;
        try {
          await this.client.send('Runtime.enable', {}, this.sessionId!);
          const evalResult = await this.client.send(
            'Runtime.evaluate',
            {
              expression:
                'JSON.stringify({ w: window.innerWidth, h: document.documentElement.scrollHeight })',
              returnByValue: true,
            },
            this.sessionId!
          );
          const val = JSON.parse((evalResult['result'] as { value?: string })?.value ?? '{}');
          cssWidth = val.w ?? 0;
          cssScrollHeight = val.h ?? 0;
        } catch (e) {
          log.warn('fullPage: failed to evaluate scroll dimensions, falling back to viewport', e);
        }

        if (options?.clip) {
          params['clip'] = { ...options.clip, scale: options.clip.scale ?? 1 };
        } else {
          // Full-page: CSS viewport width + CSS scroll height
          params['clip'] = {
            x: 0,
            y: 0,
            width: cssWidth || 1280,
            height: cssScrollHeight || 800,
            scale: 1,
          };
        }
      }
      // No clip/fullPage = viewport screenshot (Chrome's default behavior)

      let result: CdpPayload;
      try {
        result = await this.client.send('Page.captureScreenshot', params, this.sessionId!);
      } catch (err: unknown) {
        // Background/throttled tabs have a suspended renderer — wake it and
        // retry once. Foregrounding steals window focus, so callers that
        // capture in the background opt out and accept the failure instead.
        if (options?.foregroundFallback === false) throw err;
        result = await this.wakeCaptureAndRestoreFocus(params);
      }
      let base64 = result['data'] as string;

      if (options?.maxWidth) {
        base64 = await this._applyMaxWidth(base64, options.maxWidth, params);
      }

      return base64;
    } finally {
    }
  }

  /**
   * Re-capture with a downscaled clip if the image exceeds maxWidth.
   * Reads the width from the PNG IHDR and applies clip.scale to shrink.
   */
  private async _applyMaxWidth(
    base64: string,
    maxWidth: number,
    params: CdpPayload
  ): Promise<string> {
    const peekWidth = pngWidth(base64);
    if (!peekWidth || peekWidth <= maxWidth) return base64;

    const scale = maxWidth / peekWidth;
    const existingClip = params['clip'] as
      | { x: number; y: number; width: number; height: number; scale?: number }
      | undefined;

    if (existingClip) {
      existingClip.scale = scale;
    } else {
      let vw = 1280;
      let vh = 800;
      try {
        await this.client.send('Runtime.enable', {}, this.sessionId!);
        const dim = await this.client.send(
          'Runtime.evaluate',
          {
            expression: 'JSON.stringify({w:window.innerWidth,h:window.innerHeight})',
            returnByValue: true,
          },
          this.sessionId!
        );
        const v = JSON.parse((dim['result'] as { value?: string })?.value ?? '{}');
        vw = v.w || 1280;
        vh = v.h || 800;
      } catch {
        /* use defaults */
      }
      params['clip'] = { x: 0, y: 0, width: vw, height: vh, scale };
    }
    params['captureBeyondViewport'] = true;

    try {
      const resized = await this.client.send('Page.captureScreenshot', params, this.sessionId!);
      return resized['data'] as string;
    } catch (err) {
      log.warn('maxWidth re-capture failed, returning original', err);
      return base64;
    }
  }

  /**
   * Evaluate a JavaScript expression in the attached page.
   * Returns the result value.
   */
  async evaluate(expression: string, options?: EvaluateOptions): Promise<unknown> {
    await this.ensureConnected();
    this.ensureAttached();

    await this.client.send('Runtime.enable', {}, this.sessionId!);

    const result = await this.client.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: options?.awaitPromise ?? true,
        returnByValue: options?.returnByValue ?? true,
      },
      this.sessionId!
    );

    const exceptionDetails = result['exceptionDetails'] as
      | { text: string; exception?: { description?: string } }
      | undefined;
    if (exceptionDetails) {
      const msg = exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new Error(`Evaluation failed: ${msg}`);
    }

    const remoteObj = result['result'] as {
      type: string;
      value?: unknown;
      description?: string;
    };
    return remoteObj.value;
  }

  /**
   * Click an element matching a CSS selector.
   */
  async click(selector: string, modifiers = 0): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const box = await this.boundingBox(selector);
    if (!box) {
      throw new Error(`Element not found: ${selector}`);
    }

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers },
      this.sessionId!
    );
  }

  /**
   * Type text into the currently focused element.
   */
  async type(text: string): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    for (const char of text) {
      await this.client.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', text: char },
        this.sessionId!
      );
      await this.client.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', text: char },
        this.sessionId!
      );
    }
  }

  /**
   * Insert text into the currently focused element as a single composition
   * event (`Input.insertText`). Unlike `type()`, this delivers the whole
   * string in one CDP frame, which is what the per-frame whole-token
   * unmask gate in the node-server proxy keys on — a multi-keystroke
   * `Input.dispatchKeyEvent` loop fragments masked tokens across many
   * frames and cannot be unmasked. Falls back to `type()` for any frame
   * the upstream proxy might still split.
   */
  async insertText(text: string): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();
    await this.client.send('Input.insertText', { text }, this.sessionId!);
  }

  /**
   * Wait for a CSS selector to appear in the DOM.
   */
  async waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const timeout = options?.timeout ?? 30000;
    const interval = options?.interval ?? 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return;
      await new Promise((r) => setTimeout(r, interval));
    }

    throw new Error(`waitForSelector timed out after ${timeout}ms: ${selector}`);
  }

  /**
   * Get the accessibility tree of the attached page.
   *
   * Uses an injected JavaScript approach (ported from Playwright's
   * ariaSnapshot.ts) instead of CDP's Accessibility domain, so it
   * works on any browser engine (Chrome, WebKit, etc.).
   */
  async getAccessibilityTree(): Promise<AccessibilityNode> {
    await this.ensureConnected();
    this.ensureAttached();

    // Inject the aria snapshot script into the page via Runtime.evaluate.
    // This works on both CDP (Chrome) and WebKit Inspector Protocol.
    const rawResult = await this.evaluate(INJECTED_ARIA_SNAPSHOT_SCRIPT, {
      awaitPromise: false,
      returnByValue: true,
    });

    if (!rawResult || typeof rawResult !== 'object') {
      return { role: 'RootWebArea', name: '' };
    }

    // The injected script returns a tree already in AccessibilityNode format.
    // Normalize it to ensure all string fields are proper strings.
    const tree = normalizeInjectedTree(rawResult as CdpPayload);

    // Annotate the tree with backendNodeId values from the CDP Accessibility domain.
    // The injected script runs in page context and cannot access CDP backendNodeIds,
    // so we fetch them separately and match by role+name.
    try {
      const axResult = await this.client.send('Accessibility.getFullAXTree', {}, this.sessionId!);
      const nodes = axResult['nodes'] as Array<CdpPayload> | undefined;
      if (Array.isArray(nodes)) {
        annotateTreeWithBackendNodeIds(tree, buildAxNodeIndex(nodes));
      }
    } catch {
      // Accessibility domain not available in this context (e.g. WebKit, some
      // extension targets). Fall through — the CSS selector fallback still works.
    }

    return tree;
  }

  /**
   * Click an element by its CDP backend node ID.
   * Uses DOM.resolveNode to get an objectId, then calls .click() on it.
   * Falls back to bounding-box click if .click() is not appropriate.
   */
  async clickByBackendNodeId(backendNodeId: number, modifiers = 0): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    await this.client.send('DOM.enable', {}, this.sessionId!);
    await this.client.send('Runtime.enable', {}, this.sessionId!);

    // Resolve backendNodeId to a remote object
    const resolveResult = await this.client.send(
      'DOM.resolveNode',
      { backendNodeId },
      this.sessionId!
    );
    const object = resolveResult['object'] as { objectId?: string } | undefined;
    if (!object?.objectId) {
      throw new Error(`Could not resolve backend node ${backendNodeId} to a DOM element`);
    }

    // Scroll into view and get bounding box via JS
    const boxResult = await this.client.send(
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: `function() {
          this.scrollIntoView({ block: 'center', inline: 'center' });
          const r = this.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }`,
        returnByValue: true,
      },
      this.sessionId!
    );

    const boxValue = (boxResult['result'] as { value?: BoundingBox })?.value;
    if (!boxValue || boxValue.width === 0 || boxValue.height === 0) {
      // Element has no dimensions — fall back to programmatic click
      await this.client.send(
        'Runtime.callFunctionOn',
        {
          objectId: object.objectId,
          functionDeclaration: 'function() { this.click(); }',
        },
        this.sessionId!
      );
      return;
    }

    // Click at center of the element's bounding box
    const x = boxValue.x + boxValue.width / 2;
    const y = boxValue.y + boxValue.height / 2;

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers },
      this.sessionId!
    );
  }

  /**
   * Double-click an element by its CDP backend node ID.
   */
  async dblclickByBackendNodeId(
    backendNodeId: number,
    button: 'left' | 'right' | 'middle' = 'left',
    modifiers = 0
  ): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const { x, y } = await this.resolveNodeCenter(backendNodeId);

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button, clickCount: 1, modifiers },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button, clickCount: 1, modifiers },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button, clickCount: 2, modifiers },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button, clickCount: 2, modifiers },
      this.sessionId!
    );
  }

  /**
   * Hover over an element by its CDP backend node ID.
   */
  async hoverByBackendNodeId(backendNodeId: number): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const { x, y } = await this.resolveNodeCenter(backendNodeId);

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y },
      this.sessionId!
    );
  }

  /**
   * Select a value on a <select> element by its CDP backend node ID.
   */
  async selectByBackendNodeId(backendNodeId: number, value: string): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const objectId = await this.resolveNodeObjectId(backendNodeId);

    await this.client.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function(val) { this.value = val; this.dispatchEvent(new Event('change', { bubbles: true })); }`,
        arguments: [{ value }],
        returnByValue: true,
      },
      this.sessionId!
    );
  }

  /**
   * Check or uncheck a checkbox/radio element by its CDP backend node ID.
   * Only clicks if the current state differs from the desired state.
   * Returns the action taken.
   */
  async setCheckedByBackendNodeId(
    backendNodeId: number,
    checked: boolean
  ): Promise<'toggled' | 'already'> {
    await this.ensureConnected();
    this.ensureAttached();

    const objectId = await this.resolveNodeObjectId(backendNodeId);

    const stateResult = await this.client.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function() { return this.checked; }`,
        returnByValue: true,
      },
      this.sessionId!
    );
    const currentChecked = (stateResult['result'] as { value?: boolean })?.value;

    if (currentChecked === checked) {
      return 'already';
    }

    // Click to toggle
    await this.clickByBackendNodeId(backendNodeId);
    return 'toggled';
  }

  /**
   * Drag from one element to another by their CDP backend node IDs.
   */
  async dragByBackendNodeIds(startBackendNodeId: number, endBackendNodeId: number): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const start = await this.resolveNodeCenter(startBackendNodeId);
    const end = await this.resolveNodeCenter(endBackendNodeId);

    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: end.x, y: end.y },
      this.sessionId!
    );
    await this.client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', clickCount: 1 },
      this.sessionId!
    );
  }

  /**
   * Get the frame tree for the attached page as a flat list of FrameInfo objects.
   */
  async getFrameTree(): Promise<FrameInfo[]> {
    await this.ensureConnected();
    this.ensureAttached();

    await this.client.send('Page.enable', {}, this.sessionId!);
    const result = await this.client.send('Page.getFrameTree', {}, this.sessionId!);
    const frameTree = result['frameTree'] as {
      frame: { id: string; parentId?: string; url: string; name?: string; securityOrigin?: string };
      childFrames?: unknown[];
    };

    const frames: FrameInfo[] = [];
    const flatten = (node: {
      frame: {
        id: string;
        parentId?: string;
        url: string;
        name?: string;
        securityOrigin?: string;
      };
      childFrames?: unknown[];
    }): void => {
      frames.push({
        frameId: node.frame.id,
        parentFrameId: node.frame.parentId,
        url: node.frame.url,
        name: node.frame.name ?? '',
        securityOrigin: node.frame.securityOrigin,
      });
      if (Array.isArray(node.childFrames)) {
        for (const child of node.childFrames) {
          flatten(
            child as {
              frame: {
                id: string;
                parentId?: string;
                url: string;
                name?: string;
                securityOrigin?: string;
              };
              childFrames?: unknown[];
            }
          );
        }
      }
    };
    flatten(frameTree);
    return frames;
  }

  /**
   * Evaluate a JavaScript expression in a specific frame.
   * Uses an isolated world by default; callers may explicitly request the page's main world.
   */
  async evaluateInFrame(
    frameId: string,
    expression: string,
    options?: FrameEvaluateOptions
  ): Promise<unknown> {
    await this.ensureConnected();
    this.ensureAttached();

    const isDestroyedContextError = (err: unknown): boolean => {
      const message = err instanceof Error ? err.message : String(err);
      return (
        message.includes('Cannot find context with specified id') ||
        message.includes('Execution context was destroyed')
      );
    };

    const createIsolatedWorld = async (): Promise<number> => {
      const worldResult = await this.client.send(
        'Page.createIsolatedWorld',
        { frameId, worldName: '__slicc_iframe' },
        this.sessionId!
      );
      const id = worldResult['executionContextId'] as number;
      this._frameContextCache.set(frameId, id);
      return id;
    };

    const resolveContext = async (): Promise<number> => {
      if (options?.world !== 'main') {
        return this._frameContextCache.get(frameId) ?? createIsolatedWorld();
      }
      await this.client.send('Runtime.enable', {}, this.sessionId!);
      let id = this._mainWorldContextCache.get(frameId);
      if (id === undefined) {
        await this.client.send('Runtime.disable', {}, this.sessionId!);
        await this.client.send('Runtime.enable', {}, this.sessionId!);
        id = this._mainWorldContextCache.get(frameId);
      }
      if (id === undefined) {
        throw new Error(`Failed to find main world execution context for frame ${frameId}`);
      }
      return id;
    };

    const invalidateContext = (): void => {
      if (options?.world === 'main') this._mainWorldContextCache.delete(frameId);
      else this._frameContextCache.delete(frameId);
    };

    let contextId: number;
    try {
      contextId = await resolveContext();
    } catch (err) {
      const world = options?.world === 'main' ? 'main world' : 'isolated world';
      throw new Error(
        `Failed to resolve ${world} for frame ${frameId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (options?.world !== 'main') {
      await this.client.send('Runtime.enable', {}, this.sessionId!);
    }

    const evaluateParams = {
      expression,
      contextId,
      awaitPromise: options?.awaitPromise ?? true,
      returnByValue: options?.returnByValue ?? true,
    };

    let result: CdpPayload;
    try {
      result = await this.client.send('Runtime.evaluate', evaluateParams, this.sessionId!);
    } catch (err) {
      if (isDestroyedContextError(err)) {
        invalidateContext();
        contextId = await resolveContext();
        result = await this.client.send(
          'Runtime.evaluate',
          { ...evaluateParams, contextId },
          this.sessionId!
        );
      } else {
        throw err;
      }
    }

    const exceptionDetails = result['exceptionDetails'] as
      | { text: string; exception?: { description?: string } }
      | undefined;
    if (exceptionDetails) {
      const msg = exceptionDetails.exception?.description ?? exceptionDetails.text;
      // Check if this is a destroyed context error — retry once
      if (isDestroyedContextError(new Error(msg))) {
        invalidateContext();
        contextId = await resolveContext();
        const retryResult = await this.client.send(
          'Runtime.evaluate',
          { ...evaluateParams, contextId },
          this.sessionId!
        );
        const retryException = retryResult['exceptionDetails'] as
          | { text: string; exception?: { description?: string } }
          | undefined;
        if (retryException) {
          const retryMsg = retryException.exception?.description ?? retryException.text;
          throw new Error(`Evaluation in frame ${frameId} failed: ${retryMsg}`);
        }
        const retryObj = retryResult['result'] as {
          type: string;
          value?: unknown;
          description?: string;
        };
        return retryObj.value;
      }
      // Invalidate cache — the frame may have navigated
      invalidateContext();
      throw new Error(`Evaluation in frame ${frameId} failed: ${msg}`);
    }

    const remoteObj = result['result'] as {
      type: string;
      value?: unknown;
      description?: string;
    };
    return remoteObj.value;
  }

  /**
   * Get the accessibility tree for a specific frame.
   * For the main frame (no frameId), delegates to getAccessibilityTree().
   */
  async getAccessibilityTreeForFrame(frameId?: string): Promise<AccessibilityNode> {
    if (!frameId) {
      return this.getAccessibilityTree();
    }

    await this.ensureConnected();
    this.ensureAttached();

    const rawResult = await this.evaluateInFrame(frameId, INJECTED_ARIA_SNAPSHOT_SCRIPT, {
      awaitPromise: false,
      returnByValue: true,
    });

    if (!rawResult || typeof rawResult !== 'object') {
      return { role: 'RootWebArea', name: '' };
    }

    return normalizeInjectedTree(rawResult as CdpPayload);
  }

  /**
   * Send a raw CDP command on the current session.
   * Used by playwright-cli for cookie operations via the Network domain.
   */
  async sendCDP(method: string, params: CdpPayload = {}): Promise<CdpPayload> {
    await this.ensureConnected();
    this.ensureAttached();
    return await this.client.send(method, params, this.sessionId!);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve a backend node ID to a remote object ID.
   */
  private async resolveNodeObjectId(backendNodeId: number): Promise<string> {
    await this.client.send('DOM.enable', {}, this.sessionId!);
    await this.client.send('Runtime.enable', {}, this.sessionId!);

    const resolveResult = await this.client.send(
      'DOM.resolveNode',
      { backendNodeId },
      this.sessionId!
    );
    const object = resolveResult['object'] as { objectId?: string } | undefined;
    if (!object?.objectId) {
      throw new Error(`Could not resolve backend node ${backendNodeId} to a DOM element`);
    }
    return object.objectId;
  }

  /**
   * Resolve a backend node ID to the center point of its bounding box.
   * Scrolls the element into view first.
   */
  private async resolveNodeCenter(backendNodeId: number): Promise<{ x: number; y: number }> {
    const objectId = await this.resolveNodeObjectId(backendNodeId);

    const boxResult = await this.client.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function() {
          this.scrollIntoView({ block: 'center', inline: 'center' });
          const r = this.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }`,
        returnByValue: true,
      },
      this.sessionId!
    );

    const boxValue = (boxResult['result'] as { value?: BoundingBox })?.value;
    if (!boxValue || boxValue.width === 0 || boxValue.height === 0) {
      throw new Error(`Element with backend node ${backendNodeId} has no dimensions`);
    }

    return {
      x: boxValue.x + boxValue.width / 2,
      y: boxValue.y + boxValue.height / 2,
    };
  }

  /**
   * Lazily connect (or reconnect) to the CDP proxy.
   * Resets stale session/target state when reconnecting after a drop.
   * If the current client is a disconnected remote transport, restores the local transport.
   */
  private async ensureLocalConnected(): Promise<void> {
    // A superseded local client lost the single CDP proxy slot to a newer
    // tab/window — re-dialing would evict that newcomer and restart the war.
    // Surface it and leave the client disconnected.
    if (this.localClient.superseded === true) {
      this.notifySuperseded();
      return;
    }
    if (this.localClient.state === 'disconnected') {
      const opts = this._lastConnectOptions;
      await this.localClient.connect({
        url: opts?.url ?? getDefaultCdpUrl(),
        ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
        ...(opts?.protocols !== undefined ? { protocols: opts.protocols } : {}),
      });
    }
  }

  private async ensureConnected(): Promise<void> {
    // See ensureLocalConnected: don't re-dial a slot we were evicted from.
    if (this.client.superseded === true) {
      this.notifySuperseded();
      return;
    }
    if (this.client.state === 'disconnected') {
      // If we were using a remote transport that got disconnected (follower went away),
      // restore the local transport and clear stale remote state.
      if (this.remoteTargetInfo && this.trayTargetProvider?.removeRemoteTransport) {
        this.trayTargetProvider.removeRemoteTransport(
          this.remoteTargetInfo.runtimeId,
          this.remoteTargetInfo.localTargetId
        );
        this.setClient(this.localClient);
        this.remoteTargetInfo = null;
      }
      // Previous session/target are no longer valid after reconnect
      this.sessionId = null;
      this.attachedTargetId = null;
      if (this.client.state === 'disconnected') {
        // Replay the last-used connect options so the bridge URL + subprotocol survive.
        await this.connect(this._lastConnectOptions ?? undefined);
      }
    }
  }

  private ensureAttached(): void {
    if (!this.sessionId) {
      throw new Error('Not attached to a page. Call attachToPage(targetId) first.');
    }
  }

  private addDialogListener(client: CDPTransport): void {
    client.on('Page.javascriptDialogOpening', this.handleJavaScriptDialogOpening);
  }

  private addExecutionContextListeners(client: CDPTransport): void {
    client.on('Runtime.executionContextCreated', this.handleExecutionContextCreated);
    client.on('Runtime.executionContextDestroyed', this.handleExecutionContextDestroyed);
    client.on('Runtime.executionContextsCleared', this.handleExecutionContextsCleared);
  }

  private removeDialogListener(client: CDPTransport): void {
    client.off('Page.javascriptDialogOpening', this.handleJavaScriptDialogOpening);
  }

  private removeExecutionContextListeners(client: CDPTransport): void {
    client.off('Runtime.executionContextCreated', this.handleExecutionContextCreated);
    client.off('Runtime.executionContextDestroyed', this.handleExecutionContextDestroyed);
    client.off('Runtime.executionContextsCleared', this.handleExecutionContextsCleared);
  }

  private setClient(client: CDPTransport): void {
    if (this.client === client) {
      return;
    }

    this.removeDialogListener(this.client);
    this.removeExecutionContextListeners(this.client);
    this.client = client;
    this.addDialogListener(this.client);
    this.addExecutionContextListeners(this.client);
  }

  /**
   * Get the bounding box of an element by CSS selector.
   */
  private async boundingBox(selector: string): Promise<BoundingBox | null> {
    await this.client.send('DOM.enable', {}, this.sessionId!);

    const docResult = await this.client.send('DOM.getDocument', { depth: 0 }, this.sessionId!);
    const rootNodeId = (docResult['root'] as { nodeId: number }).nodeId;

    let nodeId: number;
    try {
      const queryResult = await this.client.send(
        'DOM.querySelector',
        { nodeId: rootNodeId, selector },
        this.sessionId!
      );
      nodeId = queryResult['nodeId'] as number;
    } catch {
      return null;
    }

    if (!nodeId) return null;

    const boxModel = await this.client.send('DOM.getBoxModel', { nodeId }, this.sessionId!);
    const model = boxModel['model'] as {
      content: number[];
      width: number;
      height: number;
    };

    if (!model) return null;

    // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
    const quad = model.content;
    return {
      x: quad[0],
      y: quad[1],
      width: model.width,
      height: model.height,
    };
  }
}

/**
 * Build a lookup map from (role, name) → backendDOMNodeId from the flat
 * CDP Accessibility.getFullAXTree node list.
 *
 * Keys are `${role}|${name}`. When the same role+name appears more than once
 * (e.g. two "Cancel" buttons), the first occurrence wins — that's the same
 * ambiguity the CSS selector fallback faces, so consistency matters more than
 * perfect accuracy.
 */
function buildAxNodeIndex(nodes: Array<CdpPayload>): Map<string, number> {
  const index = new Map<string, number>();
  for (const n of nodes) {
    const backendNodeId = typeof n['backendDOMNodeId'] === 'number' ? n['backendDOMNodeId'] : null;
    if (backendNodeId === null) continue;
    const roleObj = n['role'] as CdpPayload | undefined;
    const nameObj = n['name'] as CdpPayload | undefined;
    const role = typeof roleObj?.['value'] === 'string' ? roleObj['value'].toLowerCase() : '';
    const name = typeof nameObj?.['value'] === 'string' ? nameObj['value'] : '';
    if (!role) continue;
    const key = `${role}|${name}`;
    if (!index.has(key)) index.set(key, backendNodeId);
  }
  return index;
}

/**
 * Walk the injected ARIA tree and stamp each node with the backendNodeId
 * from the CDP Accessibility index (matched by role + accessible name).
 */
function annotateTreeWithBackendNodeIds(node: AccessibilityNode, index: Map<string, number>): void {
  const key = `${node.role.toLowerCase()}|${node.name}`;
  const id = index.get(key);
  if (id !== undefined) node.backendNodeId = id;
  if (node.children) {
    for (const child of node.children) annotateTreeWithBackendNodeIds(child, index);
  }
}

/**
 * Normalize the raw tree returned by the injected aria snapshot script
 * into the AccessibilityNode format expected by SLICC consumers.
 */
function normalizeInjectedTree(raw: CdpPayload): AccessibilityNode {
  const role = normalizeAccessibilityText(raw.role, 'unknown');
  const name = normalizeAccessibilityText(raw.name);

  const node: AccessibilityNode = { role, name };

  const value = normalizeAccessibilityText(raw.value);
  if (value !== '') node.value = value;

  const description = normalizeAccessibilityText(raw.description);
  if (description !== '') node.description = description;

  if (Array.isArray(raw.children) && raw.children.length > 0) {
    node.children = (raw.children as CdpPayload[])
      .map((child) => normalizeInjectedTree(child))
      .filter((c) => c.role !== 'unknown');
  }

  return node;
}
