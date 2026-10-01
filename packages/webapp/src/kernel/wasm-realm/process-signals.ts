/**
 * `process-signals.ts` — signal delivery inside a wasm-realm process worker
 * (#3530).
 *
 * The toolchain's `slicc_signals.c` exports the program's dispositions
 * (`slicc_sig_mask`) and its `raise()` (`slicc_raise`). Around every syscall
 * the {@link SignalGate}:
 *
 * - before: reports the dispositions to the kernel when they changed
 *   (`sig-mask`), so the kernel applies SIGKILL and default actions itself;
 * - after: takes the signals the kernel left pending in the SAB header and
 *   raises them, which runs the handlers (or a default action, when the
 *   program changed its mind meanwhile) — at a syscall boundary, as a real
 *   kernel delivers on return to user space.
 *
 * A blocked read, write or wait interrupted by a caught signal returns
 * EINTR; {@link SignalGate.restartable} says whether every handler just run
 * asked for SA_RESTART, in which case the runtime retries the call instead.
 */
import type { SyncFsResult } from '../realm/sync-fs-wire.js';
import type { SyncSabTransport } from '../realm/sync-sab-bridge.js';
import { SAB_I_SIGNALS } from '../realm/sync-sab-wire.js';
import { signalsIn } from './signals.js';

/** The program's signal support (absent in a program linked without the toolchain's signals). */
export interface SignalHooks {
  /** Bit masks: signals caught, ignored, and caught with SA_RESTART. */
  masks(): { caught: number; ignored: number; restart: number } | null;
  /** raise(sig) in the program: its handler, or the default action. */
  raise(sig: number): void;
}

export class SignalGate {
  private reported = { caught: 0, ignored: 0 };
  private restart = 0;
  /** The signals delivered after the last (outermost) syscall. */
  private lastDelivered = 0;
  /** Syscalls in progress: a handler's own syscalls nest inside the one it interrupted. */
  private depth = 0;
  /** Asking the program for its dispositions (see {@link report}). */
  private reporting = false;

  constructor(
    private readonly raw: SyncSabTransport,
    private readonly header: Int32Array,
    private readonly hooks: SignalHooks
  ) {}

  /** The transport the runtime uses: dispositions go out before a call, signals come in after. */
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

  /** Whether an EINTR just seen may be retried: every handler run asked for SA_RESTART. */
  restartable(): boolean {
    return this.lastDelivered !== 0 && (this.lastDelivered & ~this.restart) === 0;
  }

  private report(): void {
    // Asking the program can itself make a syscall (an assertions build that
    // aborts writes its message): that one reports nothing, and a program that
    // cannot answer keeps the dispositions last reported.
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

  /** Run the handlers of the signals pending now. */
  deliver(): void {
    const pending = Atomics.exchange(this.header, SAB_I_SIGNALS, 0);
    if (this.depth <= 1) this.lastDelivered = pending;
    for (const sig of signalsIn(pending)) this.hooks.raise(sig);
  }
}
