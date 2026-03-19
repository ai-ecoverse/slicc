/**
 * Keepalive ping/pong for WebRTC data channels.
 *
 * Sends periodic pings and expects pongs back. If {@link maxMissed}
 * consecutive pongs are missed, the {@link onDead} callback fires.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('data-channel-keepalive');

export interface DataChannelKeepaliveOptions {
  /** Send a ping message over the data channel. */
  sendPing: () => void;
  /** Called when the remote side is considered dead (too many missed pongs). */
  onDead: () => void;
  /** Ping interval in ms (default 10_000). */
  intervalMs?: number;
  /** Number of consecutive missed pongs before declaring dead (default 3). */
  maxMissed?: number;
}

export class DataChannelKeepalive {
  private readonly sendPing: () => void;
  private readonly onDead: () => void;
  private readonly intervalMs: number;
  private readonly maxMissed: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private awaitingPong = false;
  private stopped = false;

  constructor(options: DataChannelKeepaliveOptions) {
    this.sendPing = options.sendPing;
    this.onDead = options.onDead;
    this.intervalMs = options.intervalMs ?? 10_000;
    this.maxMissed = options.maxMissed ?? 3;
  }

  /** Start the keepalive interval. Safe to call multiple times. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /** Stop the keepalive. Once stopped, cannot be restarted. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Call when a pong is received from the remote side. */
  receivePong(): void {
    this.awaitingPong = false;
    this.missedPongs = 0;
  }

  /** Call when a ping is received — the caller should send a pong in response. */
  receivePing(): void {
    // Receiving a ping also proves the channel is alive, reset counters.
    this.missedPongs = 0;
    this.awaitingPong = false;
  }

  /** Exposed for testing: the number of consecutive missed pongs. */
  get missed(): number {
    return this.missedPongs;
  }

  private tick(): void {
    if (this.stopped) return;

    if (this.awaitingPong) {
      this.missedPongs++;
      log.debug('Missed pong', { missedPongs: this.missedPongs, maxMissed: this.maxMissed });
      if (this.missedPongs >= this.maxMissed) {
        log.warn('Channel declared dead', { missedPongs: this.missedPongs });
        this.stop();
        this.onDead();
        return;
      }
    }

    this.awaitingPong = true;
    this.sendPing();
  }
}
