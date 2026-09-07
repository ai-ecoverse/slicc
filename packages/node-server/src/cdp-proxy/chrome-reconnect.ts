/**
 * Chrome-leg reconnect supervisor for the node-server `/cdp` proxy.
 *
 * Chrome's browser-level debugger socket drops on its own (`messageTooLarge`,
 * an inbound-queue overflow, a devtools window stealing the single slot). When
 * it does, Chrome discards EVERY CDP session behind it. Until now node-server
 * just cleared `chromeWs` and dropped client frames on the floor until a NEW
 * `/cdp` client connected — i.e. until the SLICC tab was reloaded by hand
 * (issue #2417, `DIAGNOSIS.md` §2.6). swift-server already reconnects
 * (`CDPProxy.scheduleChromeReconnect` / `runChromeReconnectLoop`); this brings
 * node-server to parity and adds the missing half both floats needed: the
 * active client is closed with `CDP_UPSTREAM_RESET_CLOSE_CODE` so the page
 * re-dials and resets its session state instead of issuing commands against
 * sessions Chrome has forgotten.
 *
 * ## Reconnect policy (identical in node-server and swift-server)
 *
 * Retry indefinitely with a 1 s delay between attempts, until shutdown — there
 * is no attempt cap. Close the active client with 4002 `upstream-reset` after
 * the 3rd consecutive failure, so it does not hang on a proxy whose Chrome leg
 * is gone. After a successful reconnect, reset the active client ONLY if it is
 * the same client that held the slot when the Chrome leg went down — it is the
 * one whose sessions Chrome discarded. A client that connected during the
 * outage never had sessions on the dead leg and its buffered frames were just
 * flushed onto the replacement connection, so closing it with 4002 would make
 * the page retry commands that already ran (a sessionless `Target.createTarget`
 * opens a duplicate tab). Never leave a clientless buffer around: buffered
 * frames are dropped whenever the client that wrote them loses the slot.
 */

import { type ClientFrameBuffer, createClientFrameBuffer } from './client-frame-buffer.js';
import { CDP_UPSTREAM_RESET_CLOSE_CODE, CDP_UPSTREAM_RESET_CLOSE_REASON } from './close-codes.js';

/** Delay before each reconnect attempt. Mirrors swift `defaultReconnectDelayNanoseconds`. */
export const CHROME_RECONNECT_DELAY_MS = 1000;

/**
 * Consecutive failed attempts after which the active client is cut loose with
 * 4002 rather than left hanging on a proxy whose Chrome leg is gone. The loop
 * keeps retrying afterwards. Mirrors swift `upstreamResetFailureThreshold`.
 */
export const CHROME_RECONNECT_FAILURE_THRESHOLD = 3;

export interface ChromeReconnectDeps {
  /** Re-discover Chrome's browser-level ws URL (via `/json/version`). */
  discoverChromeWsUrl: () => Promise<string>;
  /** Connect the Chrome leg to `url`; rejects when the socket never opens. */
  connectChrome: (url: string) => Promise<void>;
  /** Close the active `/cdp` client with the upstream-reset code, if any. */
  resetClient: (reason: string) => void;
  /**
   * Id of the client holding the single `/cdp` slot right now, or null when it
   * is empty. Sampled on every leg drop and compared again after a successful
   * reconnect: only the holder that saw the dead leg carries stale sessions.
   */
  activeClientId: () => number | null;
  /** True once graceful shutdown started — no reconnect, no client reset. */
  isShuttingDown: () => boolean;
  /**
   * True when the Chrome leg is already open again — e.g. a NEW `/cdp` client
   * connected during the delay and `handleCdpClient` rebuilt it. That client
   * has no stale sessions, so the loop must exit WITHOUT evicting it.
   */
  isChromeLegHealthy?: () => boolean;
  /** Log one `[cdp-proxy]`-prefixed line (caller applies `CliLogDedup`). */
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  delayMs?: number;
  failureThreshold?: number;
}

/** The proxy state a Chrome-leg drop mutates (a slice of `ServerState`). */
export interface ChromeLegState<Socket = unknown> {
  chromeWs: Socket | null;
  /** Id of the Chrome connection `chromeWs` refers to (0 = never connected). */
  chromeConnectionId: number;
  /** Id of the client holding the single `/cdp` slot, or null for none. */
  activeClientId: number | null;
  /** Non-null = buffering Client→Chrome frames instead of forwarding them. */
  messageBuffer: ClientFrameBuffer | null;
  shuttingDown: boolean;
}

/**
 * Record that the Chrome leg went away: clear the socket and start buffering
 * client frames so they survive the gap (node-server used to drop them until a
 * NEW `/cdp` client connected). Returns false — meaning "do not schedule a
 * reconnect" — when the event came from a socket a newer connect already
 * replaced, or when the server is shutting down.
 *
 * The buffer opened here is tagged with the connection that just died, so the
 * flush onto the REPLACEMENT connection discards it: those frames name sessions
 * Chrome dropped with the old socket, and the client is being reset anyway.
 */
export function markChromeLegDown<Socket>(
  state: ChromeLegState<Socket>,
  droppedWs: Socket
): boolean {
  // swift-server guards the same way with `chromeConnectionID`: a late close
  // from the previous socket must not tear down the live one.
  if (state.chromeWs !== null && state.chromeWs !== droppedWs) return false;
  state.chromeWs = null;
  if (state.shuttingDown) return false;
  state.messageBuffer ??= createClientFrameBuffer({
    chromeConnectionId: state.chromeConnectionId,
    clientId: state.activeClientId,
  });
  return true;
}

/** `WebSocket.OPEN` — kept local so this module stays free of the `ws` import. */
const WS_READY_STATE_OPEN = 1;

/** Minimal `ws` surface needed to evict the active `/cdp` client. */
export interface ResettableClientSocket {
  readyState: number;
  close(code?: number, reason?: string): void;
}

/**
 * Close the active `/cdp` client with the upstream-reset code so the page
 * re-dials and rebuilds its (now dead) CDP sessions. Returns true when a close
 * was actually issued.
 */
export function closeClientForUpstreamReset(
  client: ResettableClientSocket | null | undefined,
  reason: string,
  log: (line: string) => void
): boolean {
  if (!client || client.readyState !== WS_READY_STATE_OPEN) return false;
  log(`[cdp-proxy] Closing client after Chrome-leg reset (${reason})`);
  client.close(CDP_UPSTREAM_RESET_CLOSE_CODE, CDP_UPSTREAM_RESET_CLOSE_REASON);
  return true;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Owns at most one in-flight reconnect loop. `schedule()` is idempotent — a
 * Chrome socket that fires both `error` and `close` schedules once.
 */
export class ChromeReconnectController {
  private task: Promise<void> | null = null;
  private cancelled = false;
  /** Slot holder at the most recent Chrome-leg drop — the one with stale sessions. */
  private slotHolderAtDrop: number | null = null;

  constructor(private readonly deps: ChromeReconnectDeps) {}

  /** True while a reconnect loop is running. */
  get reconnecting(): boolean {
    return this.task !== null;
  }

  /** Start the reconnect loop unless one is already running or we're shutting down. */
  schedule(reason: string): void {
    if (this.cancelled || this.deps.isShuttingDown()) {
      this.deps.log(`[cdp-proxy] Chrome WS dropped during shutdown — not reconnecting (${reason})`);
      return;
    }
    // Sampled on EVERY drop, including one that lands while a loop is already
    // running (a client that connected during the outage rebuilt the leg and
    // then lost it too): the stale-session client is whoever held the slot at
    // the most recent drop.
    this.slotHolderAtDrop = this.deps.activeClientId();
    if (this.task !== null) return;

    const delayMs = this.deps.delayMs ?? CHROME_RECONNECT_DELAY_MS;
    this.deps.log(`[cdp-proxy] Scheduling Chrome WS reconnect in ${delayMs}ms (${reason})`);
    const task = this.run(delayMs);
    this.task = task;
    void task.then(() => {
      if (this.task === task) this.task = null;
    });
  }

  /** Stop the loop (graceful shutdown). Sticky — the controller is not reused. */
  cancel(): void {
    this.cancelled = true;
  }

  /** Resolves when the current reconnect loop (if any) has finished. For tests. */
  async settled(): Promise<void> {
    await this.task;
  }

  /**
   * Retry until the leg is back or shutdown stops us — no attempt cap, so a
   * Chrome that comes back after a long outage is picked up without needing a
   * fresh client to drive discovery (swift parity).
   */
  private async run(delayMs: number): Promise<void> {
    const threshold = this.deps.failureThreshold ?? CHROME_RECONNECT_FAILURE_THRESHOLD;
    const sleep = this.deps.sleep ?? defaultSleep;
    let consecutiveFailures = 0;
    let didSignalFailure = false;

    for (;;) {
      await sleep(delayMs);
      if (this.stopped()) return;
      if (await this.attempt(consecutiveFailures + 1)) return;

      consecutiveFailures++;
      if (didSignalFailure || consecutiveFailures < threshold) continue;
      // Cut the client loose ONCE so it stops waiting on a dead proxy; the loop
      // keeps going and resets whoever holds the slot when Chrome returns.
      didSignalFailure = true;
      this.deps.log(
        `[cdp-proxy] Chrome WS reconnect failed ${consecutiveFailures}x — resetting client (still retrying)`
      );
      this.deps.resetClient('reconnect-failed');
    }
  }

  /** One discover + connect round. Returns true when the leg is back. */
  private async attempt(attempt: number): Promise<boolean> {
    if (this.deps.isChromeLegHealthy?.() === true) {
      this.deps.log('[cdp-proxy] Chrome WS already re-established — no client reset needed');
      return true;
    }
    try {
      const url = await this.deps.discoverChromeWsUrl();
      if (this.stopped()) return true;
      await this.deps.connectChrome(url);
      if (this.stopped()) return true;
      this.deps.log('[cdp-proxy] Chrome WS auto-reconnected');
      this.resetStaleSlotHolder();
      return true;
    } catch (err) {
      this.deps.log(`[cdp-proxy] Auto-reconnect attempt ${attempt} failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * Close the client that held the slot when the leg dropped: Chrome discarded
   * every session with the old socket, so that page's cached sessionIds are
   * dead and it must re-dial with a clean slate.
   *
   * A client that connected DURING the outage is left alone. It never had
   * sessions on the dead leg, and the frames it buffered were just flushed onto
   * the replacement connection — closing it with 4002 would make the page retry
   * commands that already ran, and a sessionless `Target.createTarget` among
   * them opens a duplicate tab (issue #2417). The third-failure reset clears
   * the slot, so the comparison below naturally fails for any replacement.
   */
  private resetStaleSlotHolder(): void {
    const holder = this.slotHolderAtDrop;
    const current = this.deps.activeClientId();
    if (holder !== null && current === holder) {
      this.deps.resetClient('reconnected');
      return;
    }
    if (current !== null) {
      this.deps.log(
        '[cdp-proxy] Client connected during the outage — no stale sessions, not resetting it'
      );
    }
  }

  private stopped(): boolean {
    if (!this.cancelled && !this.deps.isShuttingDown()) return false;
    this.deps.log('[cdp-proxy] Chrome WS reconnect cancelled (shutting down)');
    return true;
  }
}
