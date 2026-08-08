/**
 * Keepalive ping/pong for WebRTC data channels.
 *
 * Sends periodic pings and expects pongs back. Missing {@link maxMissed}
 * consecutive pongs means the peer is not *answering* — which is not the
 * same thing as the peer being gone.
 *
 * Both ends of the tray sync channel run this timer on the same thread that
 * serves the agent, so a peer that is merely CPU-starved (the hosted-leader
 * float shares one small sandbox between Chromium, the kernel worker, and
 * node-server) stops answering pings long before its transport dies. Treating
 * that as death tore down a perfectly healthy connection and forced a full
 * ICE/DTLS renegotiation — the disconnect was self-inflicted.
 *
 * So the state machine has two thresholds:
 *
 *   - {@link maxMissed} consecutive misses → **stalled**. Reported once via
 *     {@link DataChannelKeepaliveOptions.onStalled}; the timer keeps probing
 *     and {@link DataChannelKeepaliveOptions.onRecovered} fires when the peer
 *     answers again. No teardown.
 *   - {@link hardMaxMissed} consecutive misses → **dead**. {@link onDead}
 *     fires and the keepalive stops, exactly as before.
 *
 * The stall state only applies while {@link DataChannelKeepaliveOptions.isTransportOpen}
 * says the underlying channel is still usable. It defaults to `() => false`,
 * so a caller that does not pass it keeps the original "dead at maxMissed"
 * behavior.
 */

import { createLogger } from '../base/logger.js';

const log = createLogger('data-channel-keepalive');

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `DataChannelKeepalive ${name} must be a positive integer; got ${String(value)}`
    );
  }
}

export interface DataChannelKeepaliveOptions {
  /** Send a ping message over the data channel. */
  sendPing: () => void;
  /** Called when the remote side is considered dead (too many missed pongs). */
  onDead: () => void;
  /**
   * Whether the underlying transport still looks usable (e.g. the data
   * channel's `readyState` is `'open'`). While this returns true, crossing
   * {@link DataChannelKeepaliveOptions.maxMissed} reports a stall instead of
   * death. Defaults to `() => false` — callers that omit it keep the original
   * behavior of dying at `maxMissed`.
   */
  isTransportOpen?: () => boolean;
  /**
   * Called once when the peer crosses {@link maxMissed} while the transport is
   * still open. The connection is intact; the peer is just not answering yet.
   */
  onStalled?: () => void;
  /** Called once when a stalled peer answers again. */
  onRecovered?: () => void;
  /** Ping interval in ms (default 10_000). */
  intervalMs?: number;
  /** Number of consecutive missed pongs before reporting a stall (default 3). */
  maxMissed?: number;
  /**
   * Number of consecutive missed pongs before declaring the peer dead even
   * though its transport still looks open (default 30 — five minutes at the
   * default interval). Only consulted when `isTransportOpen` returns true;
   * a closed transport still dies at {@link maxMissed}.
   */
  hardMaxMissed?: number;
}

export class DataChannelKeepalive {
  private readonly sendPing: () => void;
  private readonly onDead: () => void;
  private readonly isTransportOpen: () => boolean;
  private readonly onStalled: (() => void) | undefined;
  private readonly onRecovered: (() => void) | undefined;
  private readonly intervalMs: number;
  private readonly maxMissed: number;
  private readonly hardMaxMissed: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private awaitingPong = false;
  private stopped = false;
  private stalled = false;

  constructor(options: DataChannelKeepaliveOptions) {
    this.sendPing = options.sendPing;
    this.onDead = options.onDead;
    this.isTransportOpen = options.isTransportOpen ?? (() => false);
    this.onStalled = options.onStalled;
    this.onRecovered = options.onRecovered;
    this.intervalMs = options.intervalMs ?? 10_000;
    this.maxMissed = options.maxMissed ?? 3;
    this.hardMaxMissed = options.hardMaxMissed ?? 30;
    assertPositiveInt('intervalMs', this.intervalMs);
    assertPositiveInt('maxMissed', this.maxMissed);
    assertPositiveInt('hardMaxMissed', this.hardMaxMissed);
    // `tick` only consults the hard deadline after `maxMissed` is crossed, so a
    // hard deadline below the soft one would silently never apply — death would
    // land at `maxMissed` instead, later than the configured hard deadline
    // promises. Reject the contradiction here rather than surprising the caller
    // with a threshold that quietly does nothing.
    if (this.hardMaxMissed < this.maxMissed) {
      throw new RangeError(
        `DataChannelKeepalive hardMaxMissed (${this.hardMaxMissed}) must be >= maxMissed (${this.maxMissed})`
      );
    }
  }

  /** Start the keepalive interval. Safe to call multiple times. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /**
   * Stop the keepalive. Once stopped, cannot be restarted. Terminal: any stall
   * is cleared without notifying, so a late pong can't report a recovery for a
   * state machine that has already given up.
   */
  stop(): void {
    this.stopped = true;
    this.stalled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Call when a pong is received from the remote side. */
  receivePong(): void {
    if (this.stopped) return;
    this.awaitingPong = false;
    this.missedPongs = 0;
    this.clearStall();
  }

  /** Call when a ping is received — the caller should send a pong in response. */
  receivePing(): void {
    if (this.stopped) return;
    // Receiving a ping also proves the channel is alive, reset counters.
    this.missedPongs = 0;
    this.awaitingPong = false;
    this.clearStall();
  }

  /** Exposed for testing: the number of consecutive missed pongs. */
  get missed(): number {
    return this.missedPongs;
  }

  /** Whether the peer is currently past `maxMissed` but still reachable. */
  get isStalled(): boolean {
    return this.stalled;
  }

  private clearStall(): void {
    if (!this.stalled) return;
    this.stalled = false;
    log.info('Peer answered again after a stall');
    this.onRecovered?.();
  }

  private tick(): void {
    if (this.stopped) return;

    if (this.awaitingPong) {
      this.missedPongs++;
      log.debug('Missed pong', { missedPongs: this.missedPongs, maxMissed: this.maxMissed });
      if (this.missedPongs >= this.maxMissed && this.declareUnreachable()) return;
    }

    this.awaitingPong = true;
    this.sendPing();
  }

  /**
   * Decide what crossing `maxMissed` means. Returns true when the keepalive
   * has died and `tick` must not send another ping.
   */
  private declareUnreachable(): boolean {
    // A peer we can still reach is busy, not gone — keep probing until the
    // hard deadline rather than tearing down a working transport.
    if (this.missedPongs < this.hardMaxMissed && this.isTransportOpen()) {
      if (!this.stalled) {
        this.stalled = true;
        log.warn('Peer stopped answering but its transport is still open — treating as stalled', {
          missedPongs: this.missedPongs,
          hardMaxMissed: this.hardMaxMissed,
        });
        this.onStalled?.();
      }
      return false;
    }
    log.warn('Channel declared dead', { missedPongs: this.missedPongs });
    this.stop();
    this.onDead();
    return true;
  }
}
