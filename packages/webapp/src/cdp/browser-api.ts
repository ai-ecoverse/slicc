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
import { waitForEvent } from './pending-request-table.js';
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

/**
 * Read PNG width from IHDR (bytes 16–19 after the 8-byte signature).
 * Returns 0 for non-PNG data — without the signature check, JPEG/WebP bytes
 * at the same offsets decode to a garbage "width" and --max-width would
 * compute a nonsensical rescale.
 */
function pngWidth(base64: string): number {
  try {
    const bin = atob(base64.slice(0, 48));
    if (!bin.startsWith('\x89PNG\r\n\x1a\n')) return 0;
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

/**
 * How many per-tab CDP sessions the registry keeps alive at once.
 *
 * Every live session costs Chrome one fan-out of every enabled domain's
 * events over the single `/cdp` socket, so an unbounded registry recreates
 * the leak it replaces (a long session drifts toward the Swift proxy's
 * inbound-queue ceiling). Evicting the least-recently-used entry — and
 * telling Chrome about it with `Target.detachFromTarget` — keeps the fan-out
 * bounded; an evicted tab simply re-attaches on next use.
 */
const MAX_TAB_SESSIONS = 32;

/** Bound for the session-scoped `Page.loadEventFired` wait in {@link BrowserAPI.navigate}. */
const NAVIGATE_LOAD_TIMEOUT_MS = 30000;

/**
 * Error texts that mean "this CDP session is gone" rather than "the command
 * failed". Chrome, the extension `chrome.debugger` bridge and the tray
 * transports each phrase it differently. A stale session is recoverable — the
 * tab is still there, only the session that addressed it died (a Chrome-leg
 * reconnect in the proxy silently discards every session on it), so
 * {@link BrowserAPI.withTab} re-attaches and retries ONCE. Any other error is
 * the caller's to see.
 */
const STALE_SESSION_ERRORS = [
  'Session with given id not found',
  'Target closed',
  'No session with given id',
  'No tab attached for sessionId',
] as const;

function isStaleSessionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return STALE_SESSION_ERRORS.some((needle) => message.includes(needle));
}

/**
 * Wait for one CDP event **belonging to a given session**.
 *
 * `CDPTransport.once()` resolves on the first matching event from ANY session,
 * which is only safe while a single session exists at a time. Layered on top
 * of `on`/`off` here rather than changed in the transports so every other
 * `once()` caller keeps its semantics.
 *
 * Events that carry no `sessionId` still match: transports that synthesize CDP
 * (cherry, the extension bridge) do not always stamp one, and dropping those
 * would hang the wait instead of fixing a bleed.
 */
function onceForSession(
  transport: CDPTransport,
  event: string,
  sessionId: string,
  timeoutMs: number
): Promise<CdpPayload> {
  return waitForEvent<CdpPayload>(
    (deliver) => {
      const listener = (params: CdpPayload): void => {
        const eventSession = params['sessionId'];
        if (typeof eventSession === 'string' && eventSession !== sessionId) return;
        deliver(params);
      };
      transport.on(event, listener);
      return () => transport.off(event, listener);
    },
    timeoutMs,
    `Timed out waiting for event: ${event}`
  );
}

/** Freeze a mutable counter set into the public {@link TabLockStats} shape. */
function statsOf(counters: TabLockCounters | undefined): TabLockStats {
  const c = counters ?? { queueDepth: 0, tabWaitMs: 0, bridgeWaitMs: 0, acquisitions: 0 };
  return {
    queueDepth: c.queueDepth,
    totalWaitMs: c.tabWaitMs + c.bridgeWaitMs,
    tabWaitMs: c.tabWaitMs,
    bridgeWaitMs: c.bridgeWaitMs,
    acquisitions: c.acquisitions,
  };
}

/**
 * One attached tab. `transport` is the channel the session lives on — the
 * local `/cdp` client, or the per-runtime remote transport for a tray target
 * ("{runtimeId}:{localTargetId}") — so a registry entry stays usable after the
 * bridge's active client swapped to another tab's transport.
 */
interface TabSession {
  sessionId: string;
  transport: CDPTransport;
  /** Set only for remote (tray) targets; drives remote-transport teardown. */
  remote?: { runtimeId: string; localTargetId: string };
}

/** Per-tab and bridge-wide contention counters — see {@link BrowserAPI.getTabLockStats}. */
export interface TabLockStats {
  queueDepth: number;
  /** All time spent queued: `tabWaitMs + bridgeWaitMs`. */
  totalWaitMs: number;
  /** Time spent waiting for THIS tab's own lock (a sibling driving the same tab). */
  tabWaitMs: number;
  /** Time spent waiting for the bridge-wide lock (a sibling driving another tab). */
  bridgeWaitMs: number;
  acquisitions: number;
}

/** Mutable per-target accumulator behind {@link TabLockStats}. */
interface TabLockCounters {
  queueDepth: number;
  tabWaitMs: number;
  bridgeWaitMs: number;
  acquisitions: number;
}

/** Notified when a target's CDP session is replaced by a fresh attach. */
export type SessionChangeCallback = (
  sessionId: string,
  transport: CDPTransport,
  targetId: string
) => void;

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
  /**
   * One live CDP session per attached target, in least-recently-used order
   * (`Map` iterates in insertion order and {@link activateSession} re-inserts
   * on use). Replaces the single `sessionId` slot that made every tab switch
   * mint — and leak — a session.
   */
  private _sessions = new Map<string, TabSession>();
  /** Transports already subscribed to session-lifecycle events. */
  private _sessionEventTransports = new Set<CDPTransport>();
  /** Per-target session-replaced subscribers (console/network/routing capture). */
  private _sessionReplacedSubs = new Map<string, Set<SessionChangeCallback>>();
  /** Per-target lock chains — commands on different tabs no longer queue behind each other. */
  private _tabLocks = new Map<string, Promise<void>>();
  /** Bridge-wide lock chain; see {@link acquireBridgeLock}. */
  private _bridgeLock: Promise<void> = Promise.resolve();
  /** Non-null while this bridge-wide lock is held, so nested sections re-enter. */
  private _bridgeHold: { release: () => void } | null = null;
  private _viewportOverrides = new Map<string, ViewportOverride>();
  private _tabLockStats = new Map<string, TabLockCounters>();
  private _onSessionChange?: SessionChangeCallback | undefined;
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
  /**
   * Chrome detached one of our sessions (tab closed, debugger taken over, the
   * proxy's Chrome leg reset). The thin extension's service worker synthesizes
   * the same event, and the tray transports relay it. Dropping the entry is
   * what stops the bridge from re-using a dead session forever.
   */
  private readonly handleDetachedFromTarget = (params: CdpPayload): void => {
    const sessionId = params['sessionId'];
    if (typeof sessionId !== 'string') return;
    for (const [targetId, entry] of this._sessions) {
      if (entry.sessionId === sessionId) {
        this.forgetSession(targetId, entry);
        return;
      }
    }
  };
  /** The tab itself went away — its session cannot be revived, so drop it. */
  private readonly handleTargetDestroyed = (params: CdpPayload): void => {
    const targetId = params['targetId'];
    if (typeof targetId !== 'string') return;
    for (const [key, entry] of this._sessions) {
      if (key === targetId || entry.remote?.localTargetId === targetId) {
        this.forgetSession(key, entry);
        return;
      }
    }
  };

  constructor(client?: CDPTransport) {
    this.client = client ?? new CDPClient();
    this.localClient = this.client;
    this.addDialogListener(this.client);
    this.addExecutionContextListeners(this.client);
    this.addSessionLifecycleListeners(this.client);
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
   * `attachToPage()`.  The callback receives the CDP session ID, the
   * transport the session lives on, and the target it belongs to — allowing
   * subscribers (e.g. BshWatchdog) to track transport swaps and know that
   * `Page.enable` has already been sent.
   *
   * The callback is **not** invoked when `attachToPage()` returns the tab's
   * existing live session (no new session was minted).
   *
   * Pass `undefined` to clear a previously registered callback. This is a
   * single global slot; per-tab subscribers use {@link onSessionReplaced}.
   */
  setSessionChangeCallback(cb: SessionChangeCallback | undefined): void {
    this._onSessionChange = cb;
  }

  /**
   * Subscribe to session replacement for ONE target. Returns an unsubscribe.
   *
   * Event-capture consumers (`console`, `requests`, `route`) bind their CDP
   * listeners to the session id they saw first and filter incoming events by
   * it. That was only safe while sessions were never detached; now that a
   * stale session self-heals into a fresh one, a capture that does not
   * re-subscribe goes silently deaf. Subscribers registered here are called
   * with the replacement session so they can re-arm.
   */
  onSessionReplaced(targetId: string, cb: SessionChangeCallback): () => void {
    let subs = this._sessionReplacedSubs.get(targetId);
    if (!subs) {
      subs = new Set();
      this._sessionReplacedSubs.set(targetId, subs);
    }
    subs.add(cb);
    return () => {
      const current = this._sessionReplacedSubs.get(targetId);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this._sessionReplacedSubs.delete(targetId);
    };
  }

  /**
   * Session ID of the most recently used tab, or `null` when none is attached.
   * With one session per tab this is a cursor into the registry, not the only
   * session that exists.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Target ID of the most recently used tab (see {@link getSessionId}).
   */
  getAttachedTargetId(): string | null {
    return this.attachedTargetId;
  }

  /**
   * Execute an operation on a specific tab.
   *
   * Serialization is now per tab: two callers driving DIFFERENT tabs no longer
   * queue behind each other, so one hung navigation can only stall its own
   * tab. A bridge-wide lock is still taken around the body because the
   * session-less convenience methods (`evaluate`, `click`, `screenshot`, …)
   * read the most-recently-used session off the bridge — see
   * {@link acquireBridgeLock}; page waits release it ({@link waitOffBridgeLock}).
   *
   * A stale session (the proxy's Chrome leg reset underneath us) is healed in
   * place: the entry is invalidated, the tab re-attached, and `fn` retried
   * exactly once.
   */
  async withTab<T>(targetId: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
    const counters = this.tabCounters(targetId);
    counters.queueDepth += 1;
    const releaseTab = await this.acquireTabLock(targetId, counters);
    try {
      const releaseBridge = await this.acquireBridgeLock({ counters });
      try {
        counters.acquisitions += 1;
        return await this.runOnTab(targetId, fn);
      } finally {
        releaseBridge();
      }
    } finally {
      counters.queueDepth -= 1;
      releaseTab();
    }
  }

  /** Attach and run, healing exactly one stale-session failure. */
  private async runOnTab<T>(targetId: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
    try {
      const sessionId = await this.attachToPage(targetId);
      return await fn(sessionId);
    } catch (err) {
      if (!isStaleSessionError(err)) throw err;
      log.warn('Stale CDP session — re-attaching and retrying once', {
        targetId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.invalidateSession(targetId);
      const sessionId = await this.attachToPage(targetId);
      return await fn(sessionId);
    }
  }

  /**
   * Contention metrics for the locks that serialize `withTab` work.
   *
   * Called with a `targetId` it reports that tab alone; called without one it
   * reports bridge-wide totals (the sum over tabs). `queueDepth` counts
   * callers currently holding or waiting, `totalWaitMs` accumulates all time
   * spent queued — split into `tabWaitMs` (a sibling driving the SAME tab) and
   * `bridgeWaitMs` (a sibling driving another tab) — and `acquisitions` counts
   * completed grants. `playwright-cli` snapshots this before and after a
   * command so a fanned-out agent can tell "my own tab is busy" from "the
   * bridge is busy" instead of guessing why calls are slow.
   */
  getTabLockStats(targetId?: string): TabLockStats {
    if (targetId !== undefined) return statsOf(this._tabLockStats.get(targetId));
    const total: TabLockCounters = {
      queueDepth: 0,
      tabWaitMs: 0,
      bridgeWaitMs: 0,
      acquisitions: 0,
    };
    for (const c of this._tabLockStats.values()) {
      total.queueDepth += c.queueDepth;
      total.tabWaitMs += c.tabWaitMs;
      total.bridgeWaitMs += c.bridgeWaitMs;
      total.acquisitions += c.acquisitions;
    }
    return statsOf(total);
  }

  private tabCounters(targetId: string): TabLockCounters {
    let counters = this._tabLockStats.get(targetId);
    if (!counters) {
      counters = { queueDepth: 0, tabWaitMs: 0, bridgeWaitMs: 0, acquisitions: 0 };
      this._tabLockStats.set(targetId, counters);
    }
    return counters;
  }

  /** FIFO lock for one target; different targets never wait on each other. */
  private async acquireTabLock(targetId: string, counters: TabLockCounters): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this._tabLocks.get(targetId) ?? Promise.resolve();
    this._tabLocks.set(targetId, next);
    const waitStart = Date.now();
    await prev;
    counters.tabWaitMs += Date.now() - waitStart;
    return () => {
      // Drop the chain once nobody is queued behind us, so a long-lived
      // bridge does not keep a resolved promise per tab it ever touched.
      if (this._tabLocks.get(targetId) === next) this._tabLocks.delete(targetId);
      release();
    };
  }

  /**
   * FIFO bridge-wide lock, held for operations that touch state shared by
   * every tab: the most-recently-used session cursor that the session-less
   * methods read, `Page.bringToFront` / focus probing, and local↔remote
   * transport swaps.
   *
   * `reentrant: true` is for helpers reached from INSIDE an operation that
   * already holds the lock (the screenshot wake-up fallback foregrounds tabs
   * and probes focus) — they must not deadlock against their own caller. A
   * fresh operation never passes it: an existing hold there belongs to another
   * caller and has to be waited out.
   */
  private async acquireBridgeLock(opts?: {
    reentrant?: boolean;
    counters?: TabLockCounters;
  }): Promise<() => void> {
    if (opts?.reentrant && this._bridgeHold) return () => undefined; // our own hold
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this._bridgeLock;
    this._bridgeLock = next;
    const waitStart = Date.now();
    await prev;
    if (opts?.counters) opts.counters.bridgeWaitMs += Date.now() - waitStart;
    this._bridgeHold = { release };
    let released = false;
    return () => {
      // Release whichever hold is current, not the one taken above: a page
      // wait may have handed the lock away and taken a fresh one back
      // (waitOffBridgeLock) while this owner was suspended.
      if (released) return;
      released = true;
      const current = this._bridgeHold;
      this._bridgeHold = null;
      current?.release();
    };
  }

  /**
   * Run a page-driven wait (a load event, a poll interval) WITHOUT holding the
   * bridge-wide lock, then take it back and restore this tab as the current
   * one before the caller continues.
   *
   * This is what keeps one hung `goto` from freezing every other tab: the
   * 30 s load wait is dead time on one tab, not a bridge-wide stall. Callers
   * must re-read nothing across the gap — the bridge cursor is restored here.
   */
  private async waitOffBridgeLock<T>(targetId: string | null, wait: () => Promise<T>): Promise<T> {
    const hold = this._bridgeHold;
    if (!hold) return wait();
    this._bridgeHold = null;
    hold.release();
    try {
      return await wait();
    } finally {
      // The enclosing owner's release closure frees whatever hold is current,
      // so the handle taken back here needs no separate bookkeeping.
      await this.acquireBridgeLock();
      if (targetId) this.restoreCurrentTarget(targetId);
    }
  }

  /**
   * Re-point the most-recently-used cursor (and, for tray targets, the active
   * transport) at `targetId` after another tab ran on the bridge. No CDP
   * round-trip: the session is still live in the registry.
   */
  private restoreCurrentTarget(targetId: string): void {
    const entry = this._sessions.get(targetId);
    if (entry) this.activateSession(targetId, entry);
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
    // Omitted options inherit the target's existing override: `resize` on a
    // tab opened with mobile emulation must change only the dimensions, not
    // silently strip the device identity (DPR / mobile layout / UA).
    const prev = this._viewportOverrides.get(targetId);
    const vp: ViewportOverride = {
      width,
      height,
      deviceScaleFactor: options?.deviceScaleFactor ?? prev?.deviceScaleFactor ?? 1,
      mobile: options?.mobile ?? prev?.mobile ?? false,
      ...((options?.userAgent ?? prev?.userAgent) !== undefined && {
        userAgent: options?.userAgent ?? prev?.userAgent,
      }),
    };
    await this.applyViewportOverride(vp, sessionId);
    this._viewportOverrides.set(targetId, vp);
  }

  /** Send the recorded metrics (and UA + touch, for mobile emulation) to a session. */
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
    if (vp.mobile) {
      // Sites that feature-detect touch (navigator.maxTouchPoints) rather
      // than sniffing width/UA won't switch layouts without this.
      await this.client.send(
        'Emulation.setTouchEmulationEnabled',
        { enabled: true, maxTouchPoints: 5 },
        sessionId
      );
    }
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
    // Detach before closing: the session dies with the tab either way, but
    // telling Chrome first is what keeps a long-lived bridge's session count
    // equal to its tab count instead of drifting upward (issue #2417).
    await this.dropSession(targetId);

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
        return;
      }
    }

    await this.localClient.send('Target.closeTarget', { targetId });
  }

  /**
   * Disconnect and clean up.
   */
  disconnect(): void {
    this.clearSessions();
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

    // One session per tab: reuse the live one. Re-attaching on every tab
    // switch is what leaked a session (and its event fan-out) per switch.
    const existing = this._sessions.get(targetId);
    if (existing) {
      this.activateSession(targetId, existing);
      return existing.sessionId;
    }

    const isRemote = !!this.trayTargetProvider?.createRemoteTransport && targetId.includes(':');
    return isRemote ? this.attachRemoteTarget(targetId) : this.attachLocalTarget(targetId);
  }

  /** Attach to a tray target ("{runtimeId}:{localTargetId}") over its remote transport. */
  private async attachRemoteTarget(targetId: string): Promise<string> {
    const colonIdx = targetId.indexOf(':');
    const runtimeId = targetId.substring(0, colonIdx);
    const localTargetId = targetId.substring(colonIdx + 1);

    // The runtimeId:localTargetId format is a strong signal this is remote.
    // Don't require registry confirmation — the target may have just been
    // created via createRemotePage() and not yet advertised.
    const remoteTransport = this.trayTargetProvider?.createRemoteTransport?.(
      runtimeId,
      localTargetId
    );
    if (!remoteTransport) throw new Error(`No remote transport for target ${targetId}`);

    const result = await remoteTransport.send('Target.attachToTarget', {
      targetId: localTargetId,
      flatten: true,
    });
    const entry: TabSession = {
      sessionId: result['sessionId'] as string,
      transport: remoteTransport,
      remote: { runtimeId, localTargetId },
    };
    this.rememberSession(targetId, entry);
    this.activateSession(targetId, entry);
    await remoteTransport.send('Page.enable', {}, entry.sessionId);
    await this.reapplyViewportOverride(targetId, entry.sessionId);
    this.notifySessionChange(targetId, entry);
    return entry.sessionId;
  }

  /** Attach to a local browser target over the `/cdp` client. */
  private async attachLocalTarget(targetId: string): Promise<string> {
    this.useLocalTransport();
    await this.ensureLocalConnected();

    const result = await this.localClient.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const entry: TabSession = {
      sessionId: result['sessionId'] as string,
      transport: this.localClient,
    };
    this.rememberSession(targetId, entry);
    this.activateSession(targetId, entry);
    // Keep Page events available so unexpected dialogs can be auto-dismissed
    // before they stall the current CDP command.
    await this.localClient.send('Page.enable', {}, entry.sessionId);
    await this.reapplyViewportOverride(targetId, entry.sessionId);
    this.notifySessionChange(targetId, entry);
    return entry.sessionId;
  }

  /**
   * Detach from the most recently used target.
   * If attached to a remote target, restores the local transport.
   */
  async detach(): Promise<void> {
    const targetId = this.attachedTargetId;
    if (!targetId) return;
    await this.dropSession(targetId);
    this.useLocalTransport();
  }

  /**
   * Navigate the attached page to a URL. Waits for THIS page's load event.
   *
   * The wait is session-scoped: with several tabs attached, an unfiltered
   * `once('Page.loadEventFired')` resolved on whichever tab loaded first, so
   * `goto` returned while its own page was still `interactive` and the next
   * snapshot showed the previous document (issue #2417). The wait also runs
   * off the bridge-wide lock, so a page that never fires `load` stalls only
   * its own tab for the 30 s bound.
   */
  async navigate(url: string): Promise<void> {
    await this.ensureConnected();
    this.ensureAttached();

    const sessionId = this.sessionId!;
    const targetId = this.attachedTargetId;
    const transport = this.client;

    // Enable Page domain for lifecycle events
    await transport.send('Page.enable', {}, sessionId);

    const loadPromise = onceForSession(
      transport,
      'Page.loadEventFired',
      sessionId,
      NAVIGATE_LOAD_TIMEOUT_MS
    );
    // Observe it before `Page.navigate` can throw: an unobserved rejection
    // from the timeout would surface as an unhandled promise rejection long
    // after the caller gave up. Awaiting `loadPromise` below still sees it.
    void loadPromise.catch(() => undefined);

    // `Page.navigate` itself does not return until the navigation commits, so
    // a URL that never responds hangs HERE, not in the load wait — both go
    // off the bridge lock or a single hung goto stalls every other tab again.
    await this.waitOffBridgeLock(targetId, async () => {
      await transport.send('Page.navigate', { url }, sessionId);
      await loadPromise;
    });
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
    // Window focus is browser-global state, not tab state: two tabs raising
    // themselves concurrently would fight. Re-entrant when a `withTab` body
    // already holds the bridge lock.
    const release = await this.acquireBridgeLock({ reentrant: true });
    try {
      await this.client.send('Page.bringToFront', {}, this.sessionId ?? undefined);
    } finally {
      release();
    }
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
    // Foregrounding and the focus probe walk every tab and move the bridge's
    // current-target cursor, so they run under the bridge-wide lock (a no-op
    // re-entry when the caller is already inside `withTab`).
    const release = await this.acquireBridgeLock({ reentrant: true });
    try {
      return await this.wakeCaptureLocked(params);
    } finally {
      release();
    }
  }

  private async wakeCaptureLocked(params: CdpPayload): Promise<CdpPayload> {
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
      // `peekWidth` is the ENCODED width, which already includes the clip's
      // own scale (e.g. --hires sets scale=DPR). Replacing the scale would
      // shrink relative to CSS pixels instead — a 2560px hires capture asked
      // to fit 1280 would come back at 640. Compose the ratios instead.
      existingClip.scale = (existingClip.scale ?? 1) * scale;
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
    const targetId = this.attachedTargetId;

    while (Date.now() - start < timeout) {
      const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return;
      // Poll intervals are this tab waiting on the page, not bridge work —
      // hand the bridge to other tabs in between (see waitOffBridgeLock).
      await this.waitOffBridgeLock(
        targetId,
        () => new Promise<void>((r) => setTimeout(r, interval))
      );
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
      // Every session lived on the transport that just dropped — Chrome
      // discards them all on reconnect, so the registry goes with it.
      this.clearSessions();
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

  /**
   * Session-lifecycle events are tracked per TRANSPORT, not per active client:
   * a tray target's session lives on its remote transport and can die while
   * the bridge is driving a local tab. Subscribing once per transport (and
   * never unsubscribing on a swap) keeps every registry entry observable.
   */
  private addSessionLifecycleListeners(client: CDPTransport): void {
    if (this._sessionEventTransports.has(client)) return;
    this._sessionEventTransports.add(client);
    client.on('Target.detachedFromTarget', this.handleDetachedFromTarget);
    client.on('Target.targetDestroyed', this.handleTargetDestroyed);
  }

  private setClient(client: CDPTransport): void {
    this.addSessionLifecycleListeners(client);
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
   * Point the bridge back at the local `/cdp` client, releasing the remote
   * transport only when no registry entry still needs it.
   */
  private useLocalTransport(): void {
    const remote = this.remoteTargetInfo;
    this.remoteTargetInfo = null;
    this.setClient(this.localClient);
    if (!remote) return;
    const stillUsed = [...this._sessions.values()].some(
      (e) =>
        e.remote?.runtimeId === remote.runtimeId && e.remote.localTargetId === remote.localTargetId
    );
    if (!stillUsed) {
      this.trayTargetProvider?.removeRemoteTransport?.(remote.runtimeId, remote.localTargetId);
    }
  }

  /** Insert a fresh session and evict the least-recently-used one over the cap. */
  private rememberSession(targetId: string, entry: TabSession): void {
    this.addSessionLifecycleListeners(entry.transport);
    this._sessions.set(targetId, entry);
    while (this._sessions.size > MAX_TAB_SESSIONS) {
      const oldest = this._sessions.keys().next().value;
      if (oldest === undefined || oldest === targetId) break;
      const evicted = this._sessions.get(oldest);
      this._sessions.delete(oldest);
      if (evicted) {
        log.debug('Evicting least-recently-used CDP session', { targetId: oldest });
        void this.detachSession(oldest, evicted);
      }
    }
  }

  /**
   * Make `targetId`'s live session the current one: point the bridge at its
   * transport, update the most-recently-used cursor read by the session-less
   * methods, and refresh its LRU position. No CDP traffic.
   */
  private activateSession(targetId: string, entry: TabSession): void {
    if (this.attachedTargetId !== targetId) {
      // Execution context IDs belong to the target we are leaving.
      this._frameContextCache.clear();
      this._mainWorldContextCache.clear();
    }
    if (entry.remote) {
      this.setClient(entry.transport);
      this.remoteTargetInfo = { ...entry.remote };
    } else if (this.client !== entry.transport) {
      this.useLocalTransport();
    }
    this.sessionId = entry.sessionId;
    this.attachedTargetId = targetId;
    // Re-insert so Map iteration order stays least-recently-used first.
    this._sessions.delete(targetId);
    this._sessions.set(targetId, entry);
  }

  private notifySessionChange(targetId: string, entry: TabSession): void {
    this._onSessionChange?.(entry.sessionId, entry.transport, targetId);
    const subs = this._sessionReplacedSubs.get(targetId);
    if (!subs) return;
    for (const cb of [...subs]) {
      try {
        cb(entry.sessionId, entry.transport, targetId);
      } catch (err) {
        log.warn('session-replaced subscriber threw', {
          targetId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Forget a session without touching the wire (it is already gone). */
  private forgetSession(targetId: string, entry: TabSession): void {
    this._sessions.delete(targetId);
    if (this.attachedTargetId === targetId) {
      this.sessionId = null;
      this.attachedTargetId = null;
    }
    if (entry.remote) {
      const stillUsed = [...this._sessions.values()].some(
        (e) =>
          e.remote?.runtimeId === entry.remote?.runtimeId &&
          e.remote?.localTargetId === entry.remote?.localTargetId
      );
      if (!stillUsed) {
        this.trayTargetProvider?.removeRemoteTransport?.(
          entry.remote.runtimeId,
          entry.remote.localTargetId
        );
      }
    }
  }

  /** Drop a session AND tell the browser about it (best effort). */
  private async detachSession(targetId: string, entry: TabSession): Promise<void> {
    this.forgetSession(targetId, entry);
    try {
      await entry.transport.send('Target.detachFromTarget', { sessionId: entry.sessionId });
    } catch {
      // Already detached, tab closed, or the transport went away — either way
      // the session is not ours any more.
    }
  }

  /** Public-path detach for one target; no-op when the tab was never attached. */
  private async dropSession(targetId: string): Promise<void> {
    const entry = this._sessions.get(targetId);
    if (!entry) {
      if (this.attachedTargetId === targetId) {
        this.sessionId = null;
        this.attachedTargetId = null;
      }
      return;
    }
    await this.detachSession(targetId, entry);
  }

  /**
   * Invalidate one target's session without a wire round-trip — used when the
   * browser has told us (by rejecting a command) that it is already gone.
   */
  private invalidateSession(targetId: string): void {
    const entry = this._sessions.get(targetId);
    if (entry) this.forgetSession(targetId, entry);
  }

  /** Drop every session: the transport they lived on is gone. */
  private clearSessions(): void {
    for (const [targetId, entry] of [...this._sessions]) this.forgetSession(targetId, entry);
    this._sessions.clear();
    this.sessionId = null;
    this.attachedTargetId = null;
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
