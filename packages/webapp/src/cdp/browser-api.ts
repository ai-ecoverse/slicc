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
import {
  CdpBridgeRejectedError,
  type CdpConnectFailureClassifier,
  CdpReconnectBackoffError,
  nextCdpReconnectDelayMs,
} from './cdp-reconnect-policy.js';
import { raceAbort, throwIfAborted } from './command-abort.js';
import { HarRecorder } from './har-recorder.js';
import { MAX_TAB_SESSIONS, SessionCache, type TabSession } from './session-cache.js';
import type {
  CdpPayload,
  ExecutionWorld,
  TabHost,
  TabPage,
  ViewportOverride,
} from './tab-handle.js';
import { TabHandle } from './tab-handle.js';
import type { CDPTransport } from './transport.js';
import type {
  CDPConnectOptions,
  CDPEventListener,
  ConnectionState,
  OpenWindowOptions,
  PageInfo,
  TargetInfo,
  WindowBounds,
  WindowBoundsInfo,
  WindowBoundsInput,
  WindowState,
} from './types.js';

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

/**
 * A session died PART WAY through a command, so what reached the page is
 * unknown. Distinct from a plain stale-session error, which means nothing
 * landed and the command can simply be replayed — this one must not be.
 */
class SessionResetError extends Error {}

function isStaleSessionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return STALE_SESSION_ERRORS.some((needle) => message.includes(needle));
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
 * A live hold on the bridge-wide lock.
 *
 * `owner` is a private token minted when the hold is taken; presenting it is
 * the ONLY way to re-enter the lock (see
 * {@link BrowserAPI.acquireBridgeLock}). `targetId` is the tab the hold is
 * driving, which is how same-tab helpers recover the token.
 */
interface BridgeHold {
  release: () => void;
  owner: symbol;
  targetId: string | null;
}

/** Options for {@link BrowserAPI.withTab}. */
export interface WithTabOptions {
  /**
   * Cooperative cancellation for the whole hold — see `CommandAbortedError`
   * (`cdp/command-abort.ts`) for exactly where it lands and what it cannot
   * cancel. Omitted, `withTab` behaves as it always has.
   */
  signal?: AbortSignal | undefined;
}

/** Per-tab and bridge-wide contention counters — see {@link BrowserAPI.getTabLockStats}. */
export interface TabLockStats {
  queueDepth: number;
  /** All time spent queued: `tabWaitMs + bridgeWaitMs`. */
  totalWaitMs: number;
  /** Time spent waiting for THIS tab's own lock (a sibling driving the same tab). */
  tabWaitMs: number;
  /**
   * Time spent waiting for the bridge-wide lock — the few genuinely global
   * operations (attaching, `Page.bringToFront`), not another tab's command
   * body, which holds nothing bridge-wide.
   */
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
 * The transport handed out by {@link BrowserAPI.getTransport}: forwards every
 * call to the real transport and credits each successful session-scoped
 * `send` to the replay guard. Handlers that talk to the transport directly
 * (`press` sends `keyDown` then `keyUp`, `console` enables `Runtime`, …) would
 * otherwise be invisible to {@link BrowserAPI.withTab}'s "has this callback
 * already changed the page?" test, and a stale session between two such
 * sends would replay the first one. One wrapper per real transport, so
 * identity is stable for `on`/`off` bookkeeping and for callers that compare
 * transports.
 */
class AccountedTransport implements CDPTransport {
  onStateChange?: CDPTransport['onStateChange'];

  constructor(
    private readonly inner: CDPTransport,
    private readonly onApplied: (sessionId: string) => void
  ) {
    if (inner.onStateChange) this.onStateChange = (listener) => inner.onStateChange!(listener);
  }

  get state(): ConnectionState {
    return this.inner.state;
  }

  get superseded(): boolean | undefined {
    return this.inner.superseded;
  }

  get isExtensionBridge(): boolean | undefined {
    return this.inner.isExtensionBridge;
  }

  connect(options?: CDPConnectOptions): Promise<void> {
    return this.inner.connect(options);
  }

  disconnect(): void {
    this.inner.disconnect();
  }

  async send(
    method: string,
    params?: CdpPayload,
    sessionId?: string,
    timeout?: number
  ): Promise<CdpPayload> {
    // Arity is preserved, not normalised: a transport that inspects
    // `arguments.length` (and every test that asserts the exact call) must see
    // the same call the caller made, not one padded with `undefined`.
    const result =
      timeout === undefined
        ? await this.inner.send(method, params, sessionId)
        : await this.inner.send(method, params, sessionId, timeout);
    if (sessionId) this.onApplied(sessionId);
    return result;
  }

  on(event: string, listener: CDPEventListener): void {
    this.inner.on(event, listener);
  }

  off(event: string, listener: CDPEventListener): void {
    this.inner.off(event, listener);
  }

  once(event: string, timeout?: number): Promise<CdpPayload> {
    return this.inner.once(event, timeout);
  }
}

export class BrowserAPI implements TabHost {
  private client: CDPTransport;
  private localClient: CDPTransport; // preserved original when using remote transport
  private sessionId: string | null = null;
  private attachedTargetId: string | null = null;
  private trayTargetProvider: TrayTargetProvider | null = null;
  private remoteTargetInfo: { runtimeId: string; localTargetId: string } | null = null;
  /**
   * frameId → executionContextId, keyed by `"<world>:<sessionId>"`.
   *
   * Per SESSION, not per bridge cursor: with commands on different tabs now
   * running concurrently, a sibling tab attaching must not invalidate this
   * tab's contexts — which is exactly what a single bridge-wide cache did.
   */
  private _frameContexts = new Map<string, Map<string, number>>();
  /**
   * One live CDP session per attached target, in least-recently-used order.
   * Owns the maps + pin/eviction policy; wire detach stays on this class.
   */
  private readonly sessions = new SessionCache(MAX_TAB_SESSIONS, (targetId, entry) => {
    log.debug('Evicting least-recently-used CDP session', { targetId });
    void this.detachSession(targetId, entry);
  });
  /** Transports already subscribed to the bridge's own CDP event listeners. */
  private _listenedTransports = new Set<CDPTransport>();
  /** Per-target session-replaced subscribers (console/network/routing capture). */
  private _sessionReplacedSubs = new Map<string, Set<SessionChangeCallback>>();
  /** Per-target lock chains — commands on different tabs no longer queue behind each other. */
  private _tabLocks = new Map<string, Promise<void>>();
  /** Bridge-wide lock chain; see {@link acquireBridgeLock}. */
  private _bridgeLock: Promise<void> = Promise.resolve();
  /** Non-null while the bridge-wide lock is held. See {@link BridgeHold}. */
  private _bridgeHold: BridgeHold | null = null;
  /** Callers queued for the bridge lock; with no hold either, it is free. */
  private _bridgeWaiters = 0;
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
  /**
   * Transient-failure backoff for lazy reconnects (`ensureConnected`).
   * `connect()` itself still dials immediately so the boot race can retry
   * on its own short schedule; the gate stops the 5s target-refresh loop
   * from opening a WebSocket on every tick.
   */
  private _reconnectAttempt = 0;
  private _reconnectNotBefore = 0;
  /** Set when the bridge refused the token. Further dials cannot succeed. */
  private _bridgeRejection: string | null = null;
  private bridgeRejectedHandler: (() => void) | null = null;
  private bridgeRejectedNotified = false;
  /**
   * Defaults to "transient" so unit tests that reject `connect()` do not
   * probe a live bridge. Standalone boot installs {@link classifyCdpConnectFailure}.
   */
  private classifyConnectFailure: CdpConnectFailureClassifier = async () => 'transient';
  private readonly handleJavaScriptDialogOpening = (params: CdpPayload): void => {
    void this.dismissJavaScriptDialog(params);
  };
  private async dismissJavaScriptDialog(params: CdpPayload): Promise<void> {
    const sessionId =
      typeof params['sessionId'] === 'string' ? (params['sessionId'] as string) : this.sessionId;
    if (!sessionId) return;

    try {
      // Sent on the transport the session actually lives on, not on whatever
      // the bridge cursor points at — with concurrent tabs those differ.
      // Deliberately NOT through a {@link TabHandle}: an auto-dismissed dialog
      // is the bridge's own housekeeping, not the running command's side
      // effect, so it must not count against `runOnTab`'s replay gate.
      await this.transportForSession(sessionId).send(
        'Page.handleJavaScriptDialog',
        { accept: false },
        sessionId,
        5000
      );
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
    const sessionId = this.eventSessionId(params);
    if (!sessionId) return;
    const context = params['context'] as
      | { id?: number; auxData?: { frameId?: string; isDefault?: boolean } }
      | undefined;
    const frameId = context?.auxData?.frameId;
    if (context?.auxData?.isDefault === true && frameId && typeof context.id === 'number') {
      this.frameContexts(sessionId, 'main').set(frameId, context.id);
    }
  };
  private readonly handleExecutionContextDestroyed = (params: CdpPayload): void => {
    const sessionId = this.eventSessionId(params);
    if (!sessionId) return;
    const contextId = params['executionContextId'];
    if (typeof contextId !== 'number') return;
    const cache = this._frameContexts.get(`main:${sessionId}`);
    if (!cache) return;
    for (const [frameId, cachedId] of cache) if (cachedId === contextId) cache.delete(frameId);
  };
  private readonly handleExecutionContextsCleared = (params: CdpPayload): void => {
    const sessionId = this.eventSessionId(params);
    if (!sessionId) return;
    this._frameContexts.get(`main:${sessionId}`)?.clear();
  };

  /**
   * The session a CDP event belongs to. Transports that synthesize CDP
   * (cherry, the extension bridge) do not always stamp one, so those fall back
   * to the bridge cursor — the single-session case they model.
   */
  private eventSessionId(params: CdpPayload): string | null {
    const id = params['sessionId'];
    return typeof id === 'string' ? id : this.sessionId;
  }
  /**
   * Chrome detached one of our sessions (tab closed, debugger taken over, the
   * proxy's Chrome leg reset). The thin extension's service worker synthesizes
   * the same event, and the tray transports relay it. Dropping the entry is
   * what stops the bridge from re-using a dead session forever.
   */
  private readonly handleDetachedFromTarget = (params: CdpPayload): void => {
    const sessionId = params['sessionId'];
    if (typeof sessionId !== 'string') return;
    const hit = this.sessions.findBySessionId(sessionId);
    if (hit) this.forgetSession(hit[0], hit[1]);
  };
  /** The tab itself went away — its session cannot be revived, so drop it. */
  private readonly handleTargetDestroyed = (params: CdpPayload): void => {
    const targetId = params['targetId'];
    if (typeof targetId !== 'string') return;
    // Match the previous loop: drop the first registry hit only.
    const hit = this.sessions.findByTargetOrLocalId(targetId)[0];
    if (hit) this.forgetSession(hit[0], hit[1]);
  };

  constructor(client?: CDPTransport) {
    this.client = client ?? new CDPClient();
    this.localClient = this.client;
    this.addTransportListeners(this.client);
  }

  /**
   * Get the underlying CDP transport.
   * Used by HarRecorder to subscribe to network events.
   */
  getTransport(): CDPTransport {
    return this.accountedTransportFor(this.client);
  }

  /**
   * The real current transport, without the accounting facade. For wiring
   * other machinery to the connection (the kernel-worker forwarder, tray
   * federation) where the transport's concrete type matters; commands issued
   * from inside a `withTab` body must go through {@link getTransport} so they
   * count toward the replay guard.
   */
  getUnderlyingTransport(): CDPTransport {
    return this.client;
  }

  private readonly _accountedTransports = new WeakMap<CDPTransport, AccountedTransport>();

  /** The stable {@link AccountedTransport} facade for a real transport. */
  private accountedTransportFor(transport: CDPTransport): CDPTransport {
    if (transport instanceof AccountedTransport) return transport;
    let facade = this._accountedTransports.get(transport);
    if (!facade) {
      facade = new AccountedTransport(transport, (sessionId) => this.noteApplied(sessionId));
      this._accountedTransports.set(transport, facade);
    }
    return facade;
  }

  /** Credit one successful session-scoped round trip to the replay guard. */
  private noteApplied(sessionId: string): void {
    this.sessions.noteApplied(sessionId);
  }

  /**
   * Construct a {@link HarRecorder} bound to a CDP transport.
   * Lets the shell-layer `record` handler create a recorder without importing
   * the cdp-layer class directly (which would invert the layer stack).
   *
   * `transport` is the channel that produced the recording's session ID — the
   * tab handle's own (`tab.transport`), never the bridge's current client:
   * with commands on different tabs running concurrently, the cursor can point
   * anywhere by the time a recorder sends.
   */
  createHarRecorder(fs: VirtualFS, transport: CDPTransport): HarRecorder {
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
   * Execute an operation on a specific tab, with a {@link TabHandle} bound to
   * that tab's live CDP session.
   *
   * Serialization is per tab and ONLY per tab: two callers driving DIFFERENT
   * tabs run concurrently, including their CDP round trips. That is what the
   * handle buys — every page operation names its session explicitly, so
   * nothing inside `fn` reads a bridge-wide "current tab" cursor and no
   * bridge-wide lock has to be held to protect one. The bridge-wide lock
   * survives only for genuinely global work: moving the cursor itself
   * (attach), window focus, and local↔remote transport swaps.
   *
   * A stale session (the proxy's Chrome leg reset underneath us) is healed in
   * place: the entry is invalidated, the tab re-attached, and `fn` retried
   * exactly once with a FRESH handle.
   *
   * `opts.signal` makes the whole hold abandonable, for a caller that has
   * stopped waiting for the result (the agent's bash tool hit its `timeout`,
   * the turn was cancelled, someone ran `kill <pid>`). It rejects a caller
   * still queued for the tab lock, gates the attach handshake, and rides the
   * {@link TabPage} handed to `fn` so every page operation stops at its next
   * step. See `CommandAbortedError` for what it cannot cancel.
   */
  async withTab<T>(
    targetId: string,
    fn: (tab: TabPage) => Promise<T>,
    opts?: WithTabOptions
  ): Promise<T> {
    const signal = opts?.signal;
    throwIfAborted(signal, `starting a command on tab ${targetId}`);
    const counters = this.tabCounters(targetId);
    counters.queueDepth += 1;
    let releaseTab: () => void;
    try {
      releaseTab = await this.acquireTabLock(targetId, counters, signal);
    } catch (err) {
      // Decremented here on the abort path: a caller that never got the lock
      // is no longer queued, and leaving it counted would inflate the
      // contention note every later command reads.
      counters.queueDepth -= 1;
      throw err;
    }
    // Pinned for the whole body: a body that waits on the page (a navigate
    // waiting for load) would otherwise age into the eviction candidate and
    // lose the session its wait is bound to.
    const unpin = this.sessions.pin(targetId);
    try {
      counters.acquisitions += 1;
      return await this.runOnTab(targetId, fn, signal);
    } finally {
      unpin();
      counters.queueDepth -= 1;
      releaseTab();
    }
  }

  /**
   * Attach and run, healing a stale-session failure that changed nothing.
   *
   * `fn` is opaque: the bridge cannot tell `title` from `type("abcdef")`.
   * Replaying it after a mid-command session death re-applied whatever it had
   * already done — `abc` typed before the drop came back as `abcabcdef`, a
   * click's `mousePressed` fired twice. So the retry is gated on the stale
   * error having been the FIRST CDP round trip of this callback on this
   * session (the attach itself, or the first send): nothing was applied, and
   * re-running is safe. A {@link SessionResetError} is the other case and is
   * never retried.
   */
  private async runOnTab<T>(
    targetId: string,
    fn: (tab: TabPage) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    try {
      return await this.attemptOnTab(targetId, fn, signal);
    } catch (err) {
      if (err instanceof SessionResetError || !isStaleSessionError(err)) throw err;
      log.warn('Stale CDP session — re-attaching and retrying once', {
        targetId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.invalidateSession(targetId);
      return await this.attemptOnTab(targetId, fn, signal);
    }
  }

  /**
   * One attempt: attach, run, and decide whether a stale-session failure left
   * the page untouched.
   *
   * Once a send has landed the outcome is genuinely unknown — the command may
   * have half-completed — so the session is invalidated and the caller gets a
   * {@link SessionResetError} saying so. Re-checking page state is the agent's
   * job then; guessing on its behalf is what corrupted input in the first
   * place.
   */
  private async attemptOnTab<T>(
    targetId: string,
    fn: (tab: TabPage) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const tab = await this.attachHandle(targetId, this.reentrantOwner(targetId), signal);
    // Attaching a fresh tab is two or three round trips of its own, each able
    // to burn a transport timeout on a slow bridge. Re-checked here so an
    // abort that landed anywhere in there stops before the body starts.
    throwIfAborted(signal, `about to run a command on tab ${targetId}`);
    const sessionId = tab.sessionId;
    const before = this.sessions.appliedCount(sessionId);
    try {
      return await fn(tab);
    } catch (err) {
      if (!isStaleSessionError(err)) throw err;
      const applied = this.sessions.appliedCount(sessionId) - before;
      if (applied === 0) throw err; // nothing landed — safe to replay
      this.invalidateSession(targetId);
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('CDP session reset mid-command — not replaying', { targetId, applied, reason });
      throw new SessionResetError(
        `The CDP session for tab ${targetId} was reset mid-command, after ${applied} ` +
          'command(s) had already been applied, so the outcome is unknown. The tab has been ' +
          `re-armed: check the page state before repeating this command. (underlying error: ${reason})`
      );
    }
  }

  /**
   * A {@link TabHandle} for an ALREADY-attached target, or a fresh attach.
   *
   * The handle carries the accounted transport facade, so every session-scoped
   * send it makes — including raw `tab.transport.send(…, tab.sessionId)` from
   * a caller — is credited to {@link runOnTab}'s replay guard.
   */
  private async attachHandle(
    targetId: string,
    owner: symbol | undefined,
    signal?: AbortSignal
  ): Promise<TabHandle> {
    const sessionId = await this.attachToPageOwned(targetId, owner, signal);
    const entry = this.sessions.get(targetId);
    return new TabHandle(
      this,
      targetId,
      sessionId,
      this.accountedTransportFor(entry?.transport ?? this.client),
      signal
    );
  }

  /** A handle over a registry entry that is already known to be live. */
  private handleFor(targetId: string, entry: TabSession): TabHandle {
    return new TabHandle(
      this,
      targetId,
      entry.sessionId,
      this.accountedTransportFor(entry.transport)
    );
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

  /**
   * FIFO lock for one target; different targets never wait on each other.
   *
   * A tab with no chain entry has no predecessor, so it neither waits nor
   * records a wait. Awaiting an already-resolved promise still costs a
   * scheduler turn that `Date.now()` can round up to 1 ms, which turned an
   * uncontended tab into a "1 ms of contention" reading — enough to make the
   * accounting test flaky and enough to mislead the `playwright-cli`
   * contention note it feeds.
   *
   * A `signal` that fires while queued rejects this caller immediately, but
   * its slot in the chain is handed on only once the PREDECESSOR actually
   * finishes — releasing early would let the next caller drive the tab
   * alongside the one still holding it.
   */
  private async acquireTabLock(
    targetId: string,
    counters: TabLockCounters,
    signal?: AbortSignal
  ): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this._tabLocks.get(targetId);
    this._tabLocks.set(targetId, next);
    const drop = (): void => {
      // Drop the chain once nobody is queued behind us, so a long-lived
      // bridge does not keep a resolved promise per tab it ever touched.
      if (this._tabLocks.get(targetId) === next) this._tabLocks.delete(targetId);
      release();
    };
    if (prev) {
      const waitStart = Date.now();
      try {
        await raceAbort(prev, signal, `queued for the lock on tab ${targetId}`);
      } catch (err) {
        counters.tabWaitMs += Date.now() - waitStart;
        void prev.then(drop, drop);
        throw err;
      }
      counters.tabWaitMs += Date.now() - waitStart;
    }
    return drop;
  }

  /**
   * FIFO bridge-wide lock, held for the operations that touch state shared by
   * every tab: the most-recently-used session cursor and the local↔remote
   * transport swap that {@link activateSession} performs, `Page.bringToFront`,
   * and the screenshot wake-up fallback's focus probe.
   *
   * It is deliberately NOT held across a command body any more. Page
   * operations name their session through a {@link TabHandle}, so there is no
   * ambient cursor for a body to protect and distinct tabs run their CDP round
   * trips concurrently.
   *
   * **Invariant: the bridge cursor (`sessionId` / `attachedTargetId`) may only
   * be moved while holding this lock.** Every public entry point that moves it
   * — {@link withTab}, {@link attachToPage}, {@link selectTab},
   * {@link bringTabToFront}, {@link bringToFront} — takes it.
   *
   * Re-entry is by TOKEN, not by "a hold exists". `opts.owner` bypasses the
   * queue only when it is the token of the live hold, and the only holders of
   * a live token are code running underneath it: the internal wake/focus
   * fallback, which is handed the token explicitly, and same-tab helpers,
   * which recover it from {@link reentrantOwner}. The boolean this replaces
   * treated ANY current hold as the caller's own, so a UI timer's
   * `attachToPage` could move the cursor out from under a running command.
   */
  private async acquireBridgeLock(opts?: {
    /** Token of the live hold this caller is already running under. */
    owner?: symbol | undefined;
    /** The tab this hold drives; what {@link reentrantOwner} matches on. */
    targetId?: string | null;
    counters?: TabLockCounters;
  }): Promise<() => void> {
    if (opts?.owner !== undefined && this._bridgeHold?.owner === opts.owner) {
      return () => undefined; // our own hold
    }
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this._bridgeLock;
    const contended = this._bridgeHold !== null || this._bridgeWaiters > 0;
    this._bridgeLock = next;
    if (contended) {
      // Nobody may be scheduled between the decrement and the hold below, so
      // "no hold and no waiter" is a reliable "the chain is already settled" —
      // which lets the uncontended path skip the await entirely. That keeps
      // taking this lock on the attach path free of an extra scheduler turn,
      // and keeps `bridgeWaitMs` from reporting the turn as contention.
      this._bridgeWaiters += 1;
      const waitStart = Date.now();
      try {
        await prev;
      } finally {
        this._bridgeWaiters -= 1;
      }
      if (opts?.counters) opts.counters.bridgeWaitMs += Date.now() - waitStart;
    }
    const hold: BridgeHold = {
      release,
      owner: Symbol('bridge-hold'),
      targetId: opts?.targetId ?? null,
    };
    this._bridgeHold = hold;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Holds never interleave — every one is taken and released inside a
      // single synchronous-ish global operation — so the live hold IS ours,
      // but check rather than assume.
      if (this._bridgeHold === hold) this._bridgeHold = null;
      release();
    };
  }

  /**
   * The live hold's token, but ONLY when that hold is driving `targetId` —
   * i.e. the caller is running inside that tab's `withTab` body (or its
   * `attachToPage`). Anything else, including a UI timer that happens to fire
   * while a command holds the bridge, gets `undefined` and queues like any
   * other caller.
   */
  private reentrantOwner(targetId: string | null): symbol | undefined {
    const hold = this._bridgeHold;
    if (!hold || targetId === null || hold.targetId !== targetId) return undefined;
    return hold.owner;
  }

  // -------------------------------------------------------------------------
  // TabHost — the slice of the bridge a {@link TabHandle} still needs
  // -------------------------------------------------------------------------

  /**
   * Run `fn` holding the bridge-wide lock, re-entering the caller's own hold
   * when it is already driving this tab. Reserved for browser-GLOBAL work:
   * `Page.bringToFront` steals window focus, so two tabs raising themselves
   * concurrently would fight.
   */
  async runGlobal<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireBridgeLock({
      owner: this.reentrantOwner(targetId),
      targetId,
    });
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** The viewport override recorded for a target, if any. */
  viewportOverride(targetId: string): ViewportOverride | undefined {
    return this._viewportOverrides.get(targetId);
  }

  /**
   * Remember a target's viewport override so every fresh attach re-applies it.
   *
   * CDP device-metrics overrides live on the CDP *session*, and a stale
   * session heals into a new one, so without this a `resize` would silently
   * evaporate and screenshots would be captured at whatever width the window
   * happens to have. Cleared by {@link closePage}.
   */
  recordViewportOverride(targetId: string, vp: ViewportOverride): void {
    this._viewportOverrides.set(targetId, vp);
  }

  /**
   * The live frameId → executionContextId cache for one session and world.
   * Keyed by session so a sibling tab's attach cannot invalidate this tab's
   * contexts.
   */
  frameContexts(sessionId: string, world: ExecutionWorld): Map<string, number> {
    const key = `${world}:${sessionId}`;
    let cache = this._frameContexts.get(key);
    if (!cache) {
      cache = new Map();
      this._frameContexts.set(key, cache);
    }
    return cache;
  }

  /** Drop both worlds' context caches for a session that is gone. */
  private dropFrameContexts(sessionId: string): void {
    this._frameContexts.delete(`main:${sessionId}`);
    this._frameContexts.delete(`isolated:${sessionId}`);
  }

  /** Re-apply a recorded viewport override after a fresh attach (best-effort). */
  private async reapplyViewportOverride(targetId: string, entry: TabSession): Promise<void> {
    const vp = this._viewportOverrides.get(targetId);
    if (!vp) return;
    try {
      await this.handleFor(targetId, entry).applyViewportOverride(vp);
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
    // An explicit connect (boot's bounded retry) dials even during the
    // backoff window. A rejected token does not: another handshake cannot
    // succeed until the tab is opened with the current token.
    if (this._bridgeRejection) {
      this.notifyBridgeRejected();
      throw new CdpBridgeRejectedError(this._bridgeRejection);
    }
    // Capture the connect options BEFORE attempting the connection so
    // subsequent lazy reconnects via `ensureConnected()` can replay the
    // same bridge URL + subprotocol even when the very first connect
    // racing against bridge startup failed.
    this._lastConnectOptions = options ? { ...options } : {};
    try {
      await this.client.connect({
        url: options?.url ?? getDefaultCdpUrl(),
        timeout: options?.timeout,
        ...(options?.protocols !== undefined ? { protocols: options.protocols } : {}),
      });
    } catch (err) {
      await this.noteReconnectFailure(options);
      if (this._bridgeRejection) throw new CdpBridgeRejectedError(this._bridgeRejection);
      throw err;
    }
    this.noteReconnectSuccess();
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
  /**
   * Re-dial the local bridge if its client is disconnected (and not
   * superseded), replaying the captured connect options.
   *
   * Standalone boot passes this to the kernel-worker forwarder
   * (`spawnKernelWorker({ reconnectCdp })`): after the `/cdp` proxy rebuilds
   * its Chrome leg it closes the page client with `upstream-reset`, and a
   * worker command that arrives before the page's own lazy reconnect would
   * otherwise fail with "not connected". Same reset semantics as the lazy
   * path every page-side call takes — the session registry is cleared.
   */
  async reconnectIfNeeded(): Promise<void> {
    await this.ensureConnected();
    // A remote (tray) transport may be current; the forwarder rides the LOCAL
    // client, so dial that too when it is a different transport.
    if (this.client !== this.localClient) await this.ensureLocalConnected();
  }

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

  /**
   * Fired once when the bridge refuses this tab's token. Boot wires a banner.
   * Pass `null` to clear.
   */
  setCdpBridgeRejectedHandler(handler: (() => void) | null): void {
    this.bridgeRejectedHandler = handler;
  }

  /** Standalone boot installs the HTTP probe. Tests install a fake. */
  setCdpConnectFailureClassifier(classifier: CdpConnectFailureClassifier): void {
    this.classifyConnectFailure = classifier;
  }

  private throwIfReconnectPaused(): void {
    if (this._bridgeRejection) {
      this.notifyBridgeRejected();
      throw new CdpBridgeRejectedError(this._bridgeRejection);
    }
    if (Date.now() < this._reconnectNotBefore) throw new CdpReconnectBackoffError();
  }

  private noteReconnectSuccess(): void {
    this._reconnectAttempt = 0;
    this._reconnectNotBefore = 0;
    // A successful (re)connect re-arms the supersede notification so a later
    // eviction can surface again.
    this.supersededNotified = false;
  }

  private async noteReconnectFailure(options?: Partial<CDPConnectOptions>): Promise<void> {
    const kind = await this.classifyConnectFailure({
      url: options?.url ?? '',
      ...(options?.protocols !== undefined ? { protocols: options.protocols } : {}),
    });
    if (kind === 'terminal') {
      this._bridgeRejection = new CdpBridgeRejectedError().message;
      this.notifyBridgeRejected();
      return;
    }
    const delay = nextCdpReconnectDelayMs(this._reconnectAttempt);
    this._reconnectAttempt += 1;
    this._reconnectNotBefore = Date.now() + delay;
  }

  private notifyBridgeRejected(): void {
    if (this.bridgeRejectedNotified) return;
    this.bridgeRejectedNotified = true;
    try {
      this.bridgeRejectedHandler?.();
    } catch {
      // A banner failure must not break the agent's CDP path.
    }
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
   * Open a sized browser window and return its first tab's targetId.
   *
   * Frame dimensions (width/height/left/top) are DIP pixels **including chrome**,
   * matching CDP and `chrome.windows` — not `window.open` content-area sizes.
   * Geometry params require `newWindow: true` on CDP (silently inert otherwise);
   * the extension bridge maps the same contract onto `chrome.windows.create`.
   */
  async openWindow(url: string, opts: OpenWindowOptions = {}): Promise<string> {
    await this.ensureConnected();
    await this.ensureLocalConnected();
    assertWindowGeometryCompatible(opts);
    const focus = opts.focus !== false;
    const params: CreateTargetWindowParams = {
      url: url || 'about:blank',
      // Sizing is inert unless newWindow is true (CDP docs). Extension bridge
      // keys off the same flag to call chrome.windows.create instead of tabs.create.
      newWindow: true,
      background: !focus,
    };
    // Extension-only hint: CDP ignores this; bridge-sw maps it to type popup|normal.
    if (opts.decorated === false) params.decorated = false;
    const state = opts.state;
    if (state && state !== 'normal') {
      params.windowState = state;
    } else {
      if (opts.width !== undefined) params.width = opts.width;
      if (opts.height !== undefined) params.height = opts.height;
      if (opts.left !== undefined) params.left = opts.left;
      if (opts.top !== undefined) params.top = opts.top;
      if (state) params.windowState = state;
    }
    const result = await this.localClient.send(
      'Target.createTarget',
      params as unknown as CdpPayload
    );
    const targetId = result['targetId'];
    if (typeof targetId !== 'string' || !targetId) {
      throw new Error('Target.createTarget did not return a usable targetId');
    }
    return targetId;
  }

  /**
   * Read the frame bounds of the window that owns `targetId`, plus the page's
   * `devicePixelRatio` (needed to predict capture resolution).
   */
  async getWindowBounds(targetId: string): Promise<WindowBoundsInfo> {
    await this.ensureConnected();
    const transport = await this.transportForWindowOps(targetId);
    const forTarget = await transport.send('Browser.getWindowForTarget', {
      targetId: localTargetIdOf(targetId),
    });
    const bounds = normalizeWindowBounds(forTarget['bounds']);
    const dpr = await this.readDevicePixelRatio(targetId);
    return { ...bounds, dpr };
  }

  /**
   * Apply frame bounds (or window state) and return the **achieved** bounds.
   * Chrome silently clamps oversized requests; callers must not trust the input.
   */
  async setWindowBounds(targetId: string, bounds: WindowBoundsInput): Promise<WindowBoundsInfo> {
    await this.ensureConnected();
    assertWindowGeometryCompatible(bounds);
    const transport = await this.transportForWindowOps(targetId);
    const localTargetId = localTargetIdOf(targetId);
    const forTarget = await transport.send('Browser.getWindowForTarget', {
      targetId: localTargetId,
    });
    const windowId = forTarget['windowId'];
    if (typeof windowId !== 'number') {
      throw new Error('Browser.getWindowForTarget did not return a windowId');
    }
    const current = normalizeWindowBounds(forTarget['bounds']);
    const state = bounds.state;
    const applyingGeometry =
      bounds.left !== undefined ||
      bounds.top !== undefined ||
      bounds.width !== undefined ||
      bounds.height !== undefined;
    // CDP + chrome.windows reject geometry while minimized/maximized/fullscreen.
    // Restore to normal first when the caller supplies only (or also) geometry.
    if (applyingGeometry && current.state !== 'normal') {
      await transport.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' } as unknown as CdpPayload,
      });
    }
    const cdpBounds: CdpBoundsPatch = {};
    if (state && state !== 'normal') {
      cdpBounds.windowState = state;
    } else {
      if (bounds.left !== undefined) cdpBounds.left = bounds.left;
      if (bounds.top !== undefined) cdpBounds.top = bounds.top;
      if (bounds.width !== undefined) cdpBounds.width = bounds.width;
      if (bounds.height !== undefined) cdpBounds.height = bounds.height;
      if (state) cdpBounds.windowState = state;
    }
    await transport.send('Browser.setWindowBounds', {
      windowId,
      bounds: cdpBounds as unknown as CdpPayload,
    });
    // Always read back — Chrome clamps without error (issue #3271).
    const achieved = await transport.send('Browser.getWindowBounds', { windowId });
    const normalized = normalizeWindowBounds(achieved['bounds']);
    const dpr = await this.readDevicePixelRatio(targetId);
    return { ...normalized, dpr };
  }

  /** Best-effort page DPR; defaults to 1 when the target cannot evaluate. */
  private async readDevicePixelRatio(targetId: string): Promise<number> {
    try {
      const value = await this.withTab(targetId, (page) =>
        page.evaluate('window.devicePixelRatio', { awaitPromise: false, returnByValue: true })
      );
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
    } catch {
      return 1;
    }
  }

  /**
   * Browser-level window commands ride the same transport as the target's
   * Chrome instance (local `/cdp` or a tray remote), never a page session.
   */
  private async transportForWindowOps(targetId: string): Promise<CDPTransport> {
    if (this.trayTargetProvider?.createRemoteTransport && targetId.includes(':')) {
      const colonIdx = targetId.indexOf(':');
      const runtimeId = targetId.substring(0, colonIdx);
      const localTargetId = targetId.substring(colonIdx + 1);
      return this.trayTargetProvider.createRemoteTransport(runtimeId, localTargetId);
    }
    await this.ensureLocalConnected();
    return this.localClient;
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
    return this.attachToPageOwned(targetId, this.reentrantOwner(targetId));
  }

  /**
   * Move the bridge cursor to a tab under the bridge lock.
   *
   * `owner` is the token of a hold the caller is already running under — the
   * `withTab` body for this same tab (recovered by {@link reentrantOwner}), or
   * the wake/focus fallback, which is handed its own token so it can walk
   * across tabs without queueing against itself. Everything else queues, which
   * is what stops a UI timer from re-pointing the cursor mid-command.
   */
  private async attachToPageOwned(
    targetId: string,
    owner: symbol | undefined,
    signal?: AbortSignal
  ): Promise<string> {
    // Counters passed so the ONLY bridge-wide wait left in a command's path —
    // moving the cursor — is still reported as `bridgeWaitMs`, and the
    // `playwright-cli` contention note keeps telling "this tab is busy" apart
    // from "the bridge is busy".
    const release = await this.acquireBridgeLock({
      owner,
      targetId,
      counters: this.tabCounters(targetId),
    });
    try {
      await this.ensureConnected();

      // One session per tab: reuse the live one. Re-attaching on every tab
      // switch is what leaked a session (and its event fan-out) per switch.
      const existing = this.sessions.get(targetId);
      if (existing) {
        this.activateSession(targetId, existing);
        return existing.sessionId;
      }

      const isRemote = !!this.trayTargetProvider?.createRemoteTransport && targetId.includes(':');
      return await (isRemote
        ? this.attachRemoteTarget(targetId, signal)
        : this.attachLocalTarget(targetId, signal));
    } finally {
      release();
    }
  }

  /**
   * Point the bridge at a tab and leave it there — the cursor move a UI switch
   * needs, taken under the same locks a command takes so it cannot land in the
   * middle of one.
   */
  async selectTab(targetId: string): Promise<void> {
    await this.withTab(targetId, async () => undefined);
  }

  /**
   * Attach to a tab and raise its window, under the command locks.
   *
   * The public entry point for foregrounding from OUTSIDE a command (the tab
   * switcher, the peek return). {@link bringToFront} is the in-command form:
   * it acts on whatever tab the caller already holds.
   */
  async bringTabToFront(targetId: string): Promise<void> {
    await this.withTab(targetId, (tab) => tab.bringToFront());
  }

  /** Attach to a tray target ("{runtimeId}:{localTargetId}") over its remote transport. */
  private async attachRemoteTarget(targetId: string, signal?: AbortSignal): Promise<string> {
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

    // Raw `transport.send`, so the handle's own cancellation boundary does not
    // apply — gated here, or an abandoned command would still pay for the
    // whole attach handshake before anything noticed.
    throwIfAborted(signal, `about to attach to tray tab ${targetId}`);
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
    throwIfAborted(signal, `about to enable Page on tray tab ${targetId}`);
    await remoteTransport.send('Page.enable', {}, entry.sessionId);
    throwIfAborted(signal, `about to restore the viewport of tray tab ${targetId}`);
    await this.reapplyViewportOverride(targetId, entry);
    this.notifySessionChange(targetId, entry);
    return entry.sessionId;
  }

  /** Attach to a local browser target over the `/cdp` client. */
  private async attachLocalTarget(targetId: string, signal?: AbortSignal): Promise<string> {
    this.useLocalTransport();
    await this.ensureLocalConnected();

    // Raw `localClient.send` — see the tray path above.
    throwIfAborted(signal, `about to attach to tab ${targetId}`);
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
    throwIfAborted(signal, `about to enable Page on tab ${targetId}`);
    await this.localClient.send('Page.enable', {}, entry.sessionId);
    throwIfAborted(signal, `about to restore the viewport of tab ${targetId}`);
    await this.reapplyViewportOverride(targetId, entry);
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
   * Foreground-fallback capture. Waking the renderer via `Page.bringToFront`
   * steals window focus — and in a capture-every-tab loop each fallback used
   * to leave the LAST captured tab in front, backgrounding SLICC (which
   * Chrome may then freeze; see docs/pitfalls.md). So: remember who held
   * focus, capture, give focus back. Restoration is best-effort and must
   * never fail the capture.
   */
  async wakeCapture(tab: TabHandle, params: CdpPayload): Promise<CdpPayload> {
    // Foregrounding and the focus probe walk every tab and move the bridge's
    // current-target cursor, so they run under the bridge-wide lock — one of
    // the few operations that still needs it.
    const release = await this.acquireBridgeLock({
      owner: this.reentrantOwner(tab.targetId),
      targetId: tab.targetId,
    });
    try {
      // Whichever hold is live now is the one this walk runs under; its token
      // is what lets the probe attach to OTHER tabs without queueing against
      // itself (and without a blanket "any hold is mine" bypass).
      return await this.wakeCaptureLocked(tab, params, this._bridgeHold?.owner);
    } finally {
      release();
    }
  }

  private async wakeCaptureLocked(
    tab: TabHandle,
    params: CdpPayload,
    owner: symbol | undefined
  ): Promise<CdpPayload> {
    const captured = tab.targetId;
    const previousFront = await this.findFocusedLocalPage(captured, owner).catch(() => null);
    // The probe attaches to candidate pages; re-attach the tab being captured
    // BEFORE fronting it, and capture through the handle that attach returns —
    // a session the probe's walk may have healed is a fresh id.
    const active = await this.attachHandle(captured, owner);
    try {
      await active.send('Page.bringToFront');
      return await active.send('Page.captureScreenshot', params);
    } finally {
      // In a finally: a retry capture that THROWS must still give focus back,
      // or a failed screenshot leaves the captured tab in front and SLICC
      // backgrounded — the exact state this helper exists to prevent.
      if (previousFront) {
        try {
          const donor = await this.attachHandle(previousFront, owner);
          await donor.send('Page.bringToFront');
          // Leave the bridge cursor where the caller expects it.
          await this.attachToPageOwned(captured, owner);
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
   * flag on targets. Attaches under the wake path's own bridge token (never
   * `withTab`) so a caller already holding the tab lock cannot deadlock; only
   * the rare foreground-fallback path pays this cost. Remote (tray) targets
   * are skipped: their focus lives on another machine.
   */
  private async findFocusedLocalPage(
    excludeTargetId: string | null,
    owner: symbol | undefined
  ): Promise<string | null> {
    const pages = await this.listPages();
    for (const page of pages) {
      if (!page.targetId || page.targetId === excludeTargetId) continue;
      if (page.targetId.includes(':')) continue; // composite = remote tray target
      try {
        const probe = await this.attachHandle(page.targetId, owner);
        const focused = await probe.evaluate('document.hasFocus()');
        if (focused === true) return page.targetId;
      } catch {
        // Unattachable candidates simply are not the focused page.
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

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
      this.throwIfReconnectPaused();
      const opts = this._lastConnectOptions;
      try {
        await this.localClient.connect({
          url: opts?.url ?? getDefaultCdpUrl(),
          ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
          ...(opts?.protocols !== undefined ? { protocols: opts.protocols } : {}),
        });
      } catch (err) {
        await this.noteReconnectFailure(opts ?? undefined);
        if (this._bridgeRejection) throw new CdpBridgeRejectedError(this._bridgeRejection);
        throw err;
      }
      this.noteReconnectSuccess();
    }
  }

  private async ensureConnected(): Promise<void> {
    // See ensureLocalConnected: don't re-dial a slot we were evicted from.
    if (this.client.superseded === true) {
      this.notifySuperseded();
      return;
    }
    if (this.client.state === 'disconnected') {
      // Before clearing sessions: a backoff tick must not drop live state
      // or open another socket.
      this.throwIfReconnectPaused();
      const dropped = this.client;
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
      // ONLY the sessions on the transport that dropped: the registry spans
      // several (the local `/cdp` client and a transport per tray runtime), and
      // Chrome discards sessions per connection. Wiping the whole map when one
      // follower went away forgot healthy local sessions WITHOUT detaching
      // them, so the next local command minted duplicates — the fan-out leak
      // this registry exists to close.
      this.clearSessionsForTransport(dropped);
      if (this.client.state === 'disconnected') {
        // Replay the last-used connect options so the bridge URL + subprotocol survive.
        await this.connect(this._lastConnectOptions ?? undefined);
      }
    }
  }

  /** The transport a live session lives on; the current client if unknown. */
  private transportForSession(sessionId: string): CDPTransport {
    return this.sessions.findBySessionId(sessionId)?.[1].transport ?? this.client;
  }

  /**
   * Subscribe the bridge's own listeners to a transport, once per transport.
   *
   * Per TRANSPORT, not per active client. A tray target's session lives on its
   * remote transport and can die — or open a dialog, or announce an execution
   * context — while the bridge is driving a local tab, and with commands on
   * different tabs now running concurrently the "active client" flips
   * underneath them. Subscribing once and never unsubscribing on a swap keeps
   * every registry entry observable; every handler routes by the event's own
   * `sessionId`.
   */
  private addTransportListeners(transport: CDPTransport): void {
    if (this._listenedTransports.has(transport)) return;
    this._listenedTransports.add(transport);
    transport.on('Page.javascriptDialogOpening', this.handleJavaScriptDialogOpening);
    transport.on('Runtime.executionContextCreated', this.handleExecutionContextCreated);
    transport.on('Runtime.executionContextDestroyed', this.handleExecutionContextDestroyed);
    transport.on('Runtime.executionContextsCleared', this.handleExecutionContextsCleared);
    transport.on('Target.detachedFromTarget', this.handleDetachedFromTarget);
    transport.on('Target.targetDestroyed', this.handleTargetDestroyed);
  }

  /**
   * Unsubscribe from a transport once no registry entry lives on it any more.
   *
   * The local `/cdp` client keeps its subscription: it is the permanent
   * channel and gets reconnected in place. Everything else is a per-runtime
   * remote transport thrown away with its last session — without this, every
   * follower this bridge ever talked to stayed in the set (and kept its
   * listeners) for the life of the page. A transport that comes back gets its
   * listeners again through {@link addTransportListeners}, which both
   * `setClient` and the attach path call.
   */
  private releaseLifecycleTransport(transport: CDPTransport): void {
    if (transport === this.localClient) return;
    if (!this._listenedTransports.has(transport)) return;
    if (this.sessions.anyOnTransport(transport)) return;
    this._listenedTransports.delete(transport);
    transport.off('Page.javascriptDialogOpening', this.handleJavaScriptDialogOpening);
    transport.off('Runtime.executionContextCreated', this.handleExecutionContextCreated);
    transport.off('Runtime.executionContextDestroyed', this.handleExecutionContextDestroyed);
    transport.off('Runtime.executionContextsCleared', this.handleExecutionContextsCleared);
    transport.off('Target.detachedFromTarget', this.handleDetachedFromTarget);
    transport.off('Target.targetDestroyed', this.handleTargetDestroyed);
  }

  private setClient(client: CDPTransport): void {
    this.addTransportListeners(client);
    this.client = client;
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
    if (!this.sessions.anyMatchingRemote(remote.runtimeId, remote.localTargetId)) {
      this.trayTargetProvider?.removeRemoteTransport?.(remote.runtimeId, remote.localTargetId);
    }
  }

  /** Insert a fresh session and evict the least-recently-used one over the cap. */
  private rememberSession(targetId: string, entry: TabSession): void {
    this.addTransportListeners(entry.transport);
    this.sessions.remember(targetId, entry);
  }

  /**
   * Make `targetId`'s live session the current one: point the bridge at its
   * transport, update the most-recently-used cursor ({@link getSessionId} /
   * {@link getAttachedTargetId}), and refresh its LRU position. No CDP
   * traffic. Only ever called under the bridge-wide lock.
   */
  private activateSession(targetId: string, entry: TabSession): void {
    // Execution-context caches are keyed by session, so moving the cursor
    // leaves them alone — a sibling tab attaching must not cost this tab its
    // resolved frame contexts.
    if (entry.remote) {
      this.setClient(entry.transport);
      this.remoteTargetInfo = { ...entry.remote };
    } else if (this.client !== entry.transport) {
      this.useLocalTransport();
    }
    this.sessionId = entry.sessionId;
    this.attachedTargetId = targetId;
    this.sessions.touch(targetId, entry);
  }

  private notifySessionChange(targetId: string, entry: TabSession): void {
    // Hand out the same facade `getTransport()` returns, so subscribers that
    // compare transports (BshWatchdog, session-rebind) see one identity.
    const transport = this.accountedTransportFor(entry.transport);
    this._onSessionChange?.(entry.sessionId, transport, targetId);
    const subs = this._sessionReplacedSubs.get(targetId);
    if (!subs) return;
    for (const cb of [...subs]) {
      try {
        cb(entry.sessionId, transport, targetId);
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
    this.unregisterSession(targetId);
    this.disposeSessionTransport(entry);
  }

  /** Remove the registry entry and clear the cursor if it pointed here (synchronous). */
  private unregisterSession(targetId: string): void {
    const entry = this.sessions.get(targetId);
    if (entry) this.dropFrameContexts(entry.sessionId);
    this.sessions.delete(targetId);
    if (this.attachedTargetId === targetId) {
      this.sessionId = null;
      this.attachedTargetId = null;
    }
  }

  /**
   * Release what the entry's transport was holding for it. For a tray target
   * this disposes the follower-side transport, so it must run AFTER any
   * `Target.detachFromTarget` that still needs that transport.
   */
  private disposeSessionTransport(entry: TabSession): void {
    this.releaseLifecycleTransport(entry.transport);
    if (entry.remote) {
      if (!this.sessions.anyMatchingRemote(entry.remote.runtimeId, entry.remote.localTargetId)) {
        this.trayTargetProvider?.removeRemoteTransport?.(
          entry.remote.runtimeId,
          entry.remote.localTargetId
        );
      }
    }
  }

  /** Drop a session AND tell the browser about it (best effort). */
  private async detachSession(targetId: string, entry: TabSession): Promise<void> {
    // Unregister synchronously so a concurrent attach never sees the entry,
    // but keep the transport alive until the browser has been told: for a
    // tray target, disposing it first would make the detach always fail and
    // leave the follower-side session leaked.
    this.unregisterSession(targetId);
    try {
      await entry.transport.send('Target.detachFromTarget', { sessionId: entry.sessionId });
    } catch {
      // Already detached, tab closed, or the transport went away — either way
      // the session is not ours any more.
    } finally {
      this.disposeSessionTransport(entry);
    }
  }

  /** Public-path detach for one target; no-op when the tab was never attached. */
  private async dropSession(targetId: string): Promise<void> {
    const entry = this.sessions.get(targetId);
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
    const entry = this.sessions.get(targetId);
    if (entry) this.forgetSession(targetId, entry);
  }

  /**
   * Drop the sessions bound to ONE transport — the connection that dropped
   * discarded them, so they cannot be detached and must not be reused.
   * Entries on other transports are healthy and stay.
   */
  private clearSessionsForTransport(transport: CDPTransport): void {
    for (const [targetId, entry] of this.sessions.snapshot()) {
      if (entry.transport === transport) this.forgetSession(targetId, entry);
    }
    // The cursor may have pointed at a survivor's tab; `forgetSession` already
    // cleared it if it pointed at one of ours.
  }

  /** Drop every session: the bridge itself is going away. */
  private clearSessions(): void {
    for (const [targetId, entry] of this.sessions.snapshot()) this.forgetSession(targetId, entry);
    this.sessions.clear();
    this.sessionId = null;
    this.attachedTargetId = null;
  }
}

const WINDOW_STATES: ReadonlySet<string> = new Set([
  'normal',
  'minimized',
  'maximized',
  'fullscreen',
]);

/** Params for `Target.createTarget` when opening a sized window. */
interface CreateTargetWindowParams {
  url: string;
  newWindow: true;
  background: boolean;
  /** Extension-only hint; CDP ignores it. */
  decorated?: false;
  windowState?: WindowState;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}

/** Partial `Browser.Bounds` patch for `Browser.setWindowBounds`. */
interface CdpBoundsPatch {
  windowState?: WindowState;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

/** Loose CDP/chrome.windows bounds payload before normalization. */
interface RawWindowBoundsFields {
  left?: unknown;
  top?: unknown;
  width?: unknown;
  height?: unknown;
  windowState?: unknown;
  state?: unknown;
}

/** Strip a tray composite id (`runtimeId:localTargetId`) down to the local id. */
function localTargetIdOf(targetId: string): string {
  const colon = targetId.indexOf(':');
  return colon >= 0 ? targetId.substring(colon + 1) : targetId;
}

/**
 * chrome.windows / CDP reject combining non-normal state with geometry.
 * Fail closed with a clear error rather than letting Chrome drop the size.
 */
function assertWindowGeometryCompatible(opts: {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  state?: WindowState;
}): void {
  const state = opts.state;
  if (!state || state === 'normal') return;
  if (!WINDOW_STATES.has(state)) {
    throw new Error(
      `window state must be one of ${[...WINDOW_STATES].join('|')} (got ${JSON.stringify(state)})`
    );
  }
  const hasGeometry =
    opts.left !== undefined ||
    opts.top !== undefined ||
    opts.width !== undefined ||
    opts.height !== undefined;
  if (hasGeometry) {
    throw new Error(
      `window state '${state}' cannot be combined with left/top/width/height (chrome.windows + CDP both reject the mix)`
    );
  }
}

function isRawWindowBoundsFields(value: unknown): value is RawWindowBoundsFields {
  return value !== null && typeof value === 'object';
}

function normalizeWindowBounds(raw: unknown): WindowBounds {
  const obj: RawWindowBoundsFields = isRawWindowBoundsFields(raw) ? raw : {};
  const stateRaw = obj.windowState ?? obj.state;
  const state: WindowState =
    typeof stateRaw === 'string' && WINDOW_STATES.has(stateRaw)
      ? (stateRaw as WindowState)
      : 'normal';
  return {
    left: numOr(obj.left, 0),
    top: numOr(obj.top, 0),
    width: numOr(obj.width, 0),
    height: numOr(obj.height, 0),
    state,
  };
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
