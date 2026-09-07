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
 * node-server to parity and adds the missing half both floats needed: once the
 * Chrome leg is back (or definitively gone), the active client is closed with
 * `CDP_UPSTREAM_RESET_CLOSE_CODE` so the page re-dials and resets its session
 * state instead of issuing commands against sessions Chrome has forgotten.
 */

import { CDP_UPSTREAM_RESET_CLOSE_CODE, CDP_UPSTREAM_RESET_CLOSE_REASON } from './close-codes.js';

/** Delay before each reconnect attempt. Mirrors swift `defaultReconnectDelayNanoseconds`. */
export const CHROME_RECONNECT_DELAY_MS = 1000;

/**
 * Attempts before the supervisor gives up and resets the client anyway. Swift
 * retries forever; here a bounded loop is better because closing the client
 * makes the page re-dial `/cdp`, and a fresh client runs the full discovery
 * path (`waitForCDP` → `ensureChromeConnection`) from scratch.
 */
export const CHROME_RECONNECT_MAX_ATTEMPTS = 10;

export interface ChromeReconnectDeps {
  /** Re-discover Chrome's browser-level ws URL (via `/json/version`). */
  discoverChromeWsUrl: () => Promise<string>;
  /** Connect the Chrome leg to `url`; rejects when the socket never opens. */
  connectChrome: (url: string) => Promise<void>;
  /** Close the active `/cdp` client with the upstream-reset code, if any. */
  resetClient: (reason: string) => void;
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
  maxAttempts?: number;
}

/** The proxy state a Chrome-leg drop mutates (a slice of `ServerState`). */
export interface ChromeLegState<Socket = unknown> {
  chromeWs: Socket | null;
  /** Non-null = buffering Client→Chrome frames instead of forwarding them. */
  messageBuffer: unknown[] | null;
  shuttingDown: boolean;
}

/**
 * Record that the Chrome leg went away: clear the socket and start buffering
 * client frames so they survive the gap (node-server used to drop them until a
 * NEW `/cdp` client connected). Returns false — meaning "do not schedule a
 * reconnect" — when the event came from a socket a newer connect already
 * replaced, or when the server is shutting down.
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
  if (state.messageBuffer === null) state.messageBuffer = [];
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

  private async run(delayMs: number): Promise<void> {
    const maxAttempts = this.deps.maxAttempts ?? CHROME_RECONNECT_MAX_ATTEMPTS;
    const sleep = this.deps.sleep ?? defaultSleep;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await sleep(delayMs);
      if (this.stopped()) return;
      if (await this.attempt(attempt, maxAttempts)) return;
    }

    if (this.stopped()) return;
    this.deps.log(
      `[cdp-proxy] Chrome WS reconnect gave up after ${maxAttempts} attempts — resetting client`
    );
    this.deps.resetClient('reconnect-failed');
  }

  /** One discover + connect round. Returns true when the leg is back. */
  private async attempt(attempt: number, maxAttempts: number): Promise<boolean> {
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
      // Chrome dropped every session with the old socket, so the page's cached
      // sessionIds are stale — close it so it re-dials with a clean slate.
      this.deps.resetClient('reconnected');
      return true;
    } catch (err) {
      this.deps.log(
        `[cdp-proxy] Auto-reconnect attempt ${attempt}/${maxAttempts} failed: ${String(err)}`
      );
      return false;
    }
  }

  private stopped(): boolean {
    if (!this.cancelled && !this.deps.isShuttingDown()) return false;
    this.deps.log('[cdp-proxy] Chrome WS reconnect cancelled (shutting down)');
    return true;
  }
}
