import type { SyncFsResult } from '../realm/sync-fs-wire.js';
import type { SyncSabTransport } from '../realm/sync-sab-bridge.js';
import { SAB_I_SIGNALS } from '../realm/sync-sab-wire.js';
import { signalsIn } from './signals.js';

export interface SignalHooks {
  masks(): { caught: number; ignored: number; restart: number } | null;

  raise(sig: number): void;
}

export class SignalGate {
  private reported = { caught: 0, ignored: 0 };
  private restart = 0;

  private lastDelivered = 0;

  private depth = 0;

  private reporting = false;

  constructor(
    private readonly raw: SyncSabTransport,
    private readonly header: Int32Array,
    private readonly hooks: SignalHooks
  ) {}

  transport(): SyncSabTransport {
    return {
      call: (req, timeoutMs, label): SyncFsResult => {
        this.report();
        this.depth++;
        try {
          const result = this.raw.call(req, timeoutMs, label);
          this.deliver();
          return result;
        } finally {
          this.depth--;
        }
      },
    };
  }

  restartable(): boolean {
    return this.lastDelivered !== 0 && (this.lastDelivered & ~this.restart) === 0;
  }

  private report(): void {
    if (this.reporting) return;
    this.reporting = true;
    let masks: ReturnType<SignalHooks['masks']>;
    try {
      masks = this.hooks.masks();
    } catch {
      masks = null;
    } finally {
      this.reporting = false;
    }
    if (!masks) return;
    this.restart = masks.restart;
    const { caught, ignored } = masks;
    if (caught === this.reported.caught && ignored === this.reported.ignored) return;
    this.reported = { caught, ignored };
    this.raw.call({ op: 'sig-mask', caught, ignored }, Number.POSITIVE_INFINITY, 'sig-mask');
  }

  deliver(): void {
    const pending = Atomics.exchange(this.header, SAB_I_SIGNALS, 0);
    if (this.depth <= 1) this.lastDelivered = pending;
    for (const sig of signalsIn(pending)) this.hooks.raise(sig);
  }
}
