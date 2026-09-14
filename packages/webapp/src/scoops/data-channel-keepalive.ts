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
  sendPing: () => void;

  onDead: () => void;

  isTransportOpen?: () => boolean;

  onStalled?: () => void;

  onRecovered?: () => void;

  intervalMs?: number;

  maxMissed?: number;

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

    if (this.hardMaxMissed < this.maxMissed) {
      throw new RangeError(
        `DataChannelKeepalive hardMaxMissed (${this.hardMaxMissed}) must be >= maxMissed (${this.maxMissed})`
      );
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.stalled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  receivePong(): void {
    if (this.stopped) return;
    this.awaitingPong = false;
    this.missedPongs = 0;
    this.clearStall();
  }

  receivePing(): void {
    if (this.stopped) return;

    this.missedPongs = 0;
    this.awaitingPong = false;
    this.clearStall();
  }

  get missed(): number {
    return this.missedPongs;
  }

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

  private declareUnreachable(): boolean {
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
