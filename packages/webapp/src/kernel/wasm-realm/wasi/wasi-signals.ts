import type { SignalHooks } from '../process-signals.js';
import { SIG, sigbit } from '../signals.js';

const DELIVERED = [SIG.HUP, SIG.INT, SIG.QUIT, SIG.USR1, SIG.USR2, SIG.ALRM, SIG.TERM];
const DELIVERED_MASK = DELIVERED.reduce((m, sig) => m | sigbit(sig), 0);

export class WasiSignals implements SignalHooks {
  private exports: WebAssembly.Exports | undefined;
  private callback: string | undefined;

  private uncaught = 0;

  private delivering: number | undefined;

  constructor(private readonly fallBack: (sig: number) => void) {}

  bind(exports: WebAssembly.Exports): void {
    this.exports = exports;
  }

  register(name: string): void {
    if (typeof this.exports?.[name] === 'function') this.callback = name;
  }

  masks(): { caught: number; ignored: number; restart: number } | null {
    if (!this.handler()) return null;
    return { caught: DELIVERED_MASK & ~this.uncaught, ignored: 0, restart: 0 };
  }

  raise(sig: number): void {
    const handler = this.handler();
    if (!handler) return;
    const outer = this.delivering;
    this.delivering = sig;
    try {
      handler(sig);
    } catch (e) {
      if (!(e instanceof WebAssembly.RuntimeError)) throw e;
      this.defaultAction(sig);
    } finally {
      this.delivering = outer;
    }
  }

  raised(sig: number): boolean {
    if (sig !== SIG.ABRT || this.delivering === undefined) return false;
    this.defaultAction(this.delivering);
    return true;
  }

  private defaultAction(sig: number): void {
    this.uncaught |= sigbit(sig);
    this.fallBack(sig);
  }

  private handler(): ((sig: number) => void) | undefined {
    const fn = this.callback ? this.exports?.[this.callback] : undefined;
    return typeof fn === 'function' ? (fn as (sig: number) => void) : undefined;
  }
}
