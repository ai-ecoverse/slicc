/**
 * `wasi-signals.ts` — a WASIX program's signal handlers (#3530 phase 5f).
 *
 * wasix-libc keeps the handlers in its own memory. Its first `sigaction`
 * registers an export with `callback_signal` (`__wasm_signal`), which runs
 * the handler for a signal number — or the libc's default action, which
 * aborts. The libc never says which signals it catches.
 *
 * So once a program registered its callback, the terminating signals it
 * could catch are reported to the kernel as caught (`sig-mask`, through the
 * {@link SignalGate}). The kernel leaves them pending, and interrupts a
 * blocked call with EINTR. After each syscall the gate hands them here, and
 * `__wasm_signal` runs — as Wasmer delivers them, at a syscall boundary.
 * Where the program has no handler, the libc's default action aborts inside
 * the call. The kernel then carries the default action out instead: the
 * signal is no longer reported caught, and is raised again, so the process
 * ends WIFSIGNALED as it should.
 *
 * SIGPIPE and SIGXFSZ are left out: Python sets them to SIG_IGN, which the
 * libc would call as a function. Stop, continue and ignore defaults stay
 * the kernel's.
 */

import type { SignalHooks } from '../process-signals.js';
import { SIG, sigbit } from '../signals.js';

/** The signals delivered to a registered callback (their default is to terminate). */
const DELIVERED = [SIG.HUP, SIG.INT, SIG.QUIT, SIG.USR1, SIG.USR2, SIG.ALRM, SIG.TERM];
const DELIVERED_MASK = DELIVERED.reduce((m, sig) => m | sigbit(sig), 0);

export class WasiSignals implements SignalHooks {
  private exports: WebAssembly.Exports | undefined;
  private callback: string | undefined;
  /** Signals found to have no handler: the kernel's default action is theirs now. */
  private uncaught = 0;
  /** The signal whose handler (or libc default action) is running. */
  private delivering: number | undefined;

  /**
   * @param fallBack the default action of `sig`, carried out by the kernel
   *   (the caught mask no longer has it, so the kernel ends the process).
   */
  constructor(private readonly fallBack: (sig: number) => void) {}

  /** The program instance, whose export the callback names. */
  bind(exports: WebAssembly.Exports): void {
    this.exports = exports;
  }

  /**
   * callback_signal: the export that runs a signal's handler. A name the
   * program does not export is ignored (wasix-libc names
   * `__wasm_signal_blocked` while it runs a default action, and not every
   * build exports it): the callback it had stays.
   */
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
      // The libc's default action: abort(). The kernel carries it out.
      if (!(e instanceof WebAssembly.RuntimeError)) throw e;
      this.defaultAction(sig);
    } finally {
      this.delivering = outer;
    }
  }

  /**
   * The program raises `sig` itself (proc_raise). SIGABRT while a signal's
   * default action runs is the libc's way to carry that action out (its
   * terminate handler prints, then aborts): the kernel carries out the
   * delivered signal's instead, so the process ends by it, not by SIGABRT.
   * True when handled here.
   */
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
