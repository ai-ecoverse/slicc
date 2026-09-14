import { type ClientFrameBuffer, createClientFrameBuffer } from './client-frame-buffer.js';
import { CDP_UPSTREAM_RESET_CLOSE_CODE, CDP_UPSTREAM_RESET_CLOSE_REASON } from './close-codes.js';

export const CHROME_RECONNECT_DELAY_MS = 1000;

export const CHROME_RECONNECT_FAILURE_THRESHOLD = 3;

export interface ChromeReconnectDeps {
  discoverChromeWsUrl: () => Promise<string>;

  connectChrome: (url: string) => Promise<void>;

  resetClient: (reason: string) => void;

  activeClientId: () => number | null;

  isShuttingDown: () => boolean;

  isChromeLegHealthy?: () => boolean;

  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  delayMs?: number;
  failureThreshold?: number;
}

export interface ChromeLegState<Socket = unknown> {
  chromeWs: Socket | null;

  chromeConnectionId: number;

  activeClientId: number | null;

  messageBuffer: ClientFrameBuffer | null;
  shuttingDown: boolean;
}

export function markChromeLegDown<Socket>(
  state: ChromeLegState<Socket>,
  droppedWs: Socket
): boolean {
  if (state.chromeWs !== null && state.chromeWs !== droppedWs) return false;
  state.chromeWs = null;
  if (state.shuttingDown) return false;
  state.messageBuffer ??= createClientFrameBuffer({
    chromeConnectionId: state.chromeConnectionId,
    clientId: state.activeClientId,
  });
  return true;
}

const WS_READY_STATE_OPEN = 1;

export interface ResettableClientSocket {
  readyState: number;
  close(code?: number, reason?: string): void;
}

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

export class ChromeReconnectController {
  private task: Promise<void> | null = null;
  private cancelled = false;

  private slotHolderAtDrop: number | null = null;

  constructor(private readonly deps: ChromeReconnectDeps) {}

  get reconnecting(): boolean {
    return this.task !== null;
  }

  schedule(reason: string): void {
    if (this.cancelled || this.deps.isShuttingDown()) {
      this.deps.log(`[cdp-proxy] Chrome WS dropped during shutdown — not reconnecting (${reason})`);
      return;
    }

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

  cancel(): void {
    this.cancelled = true;
  }

  async settled(): Promise<void> {
    await this.task;
  }

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

      didSignalFailure = true;
      this.deps.log(
        `[cdp-proxy] Chrome WS reconnect failed ${consecutiveFailures}x — resetting client (still retrying)`
      );
      this.deps.resetClient('reconnect-failed');
    }
  }

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
