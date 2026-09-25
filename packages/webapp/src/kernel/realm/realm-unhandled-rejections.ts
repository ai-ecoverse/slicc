/**
 * Node ends a program on an unhandled promise rejection: it prints the reason
 * and exits 1 (`--unhandled-rejections=throw`, the default since Node 15). A
 * realm worker only fires `unhandledrejection` at its global scope, so without
 * this watcher the program ended silently with 0 — or with a stale
 * `process.exitCode`, still without a word. An Emscripten program whose main
 * traps (`RuntimeError: memory access out of bounds`) is the common case: the
 * glue sets `process.exitCode = 1` and rethrows the trap from a promise
 * callback.
 */

import { NodeExitError } from './realm-node-shims.js';

type RejectionTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface UnhandledRejectionWatch {
  /** Resolves once an unhandled rejection has ended the program. */
  readonly fatal: Promise<void>;
  dispose(): void;
}

export interface UnhandledRejectionOptions {
  writeStderr: (value: unknown) => void;
  /** Whether `process.exit()` already ended the program. */
  didExit: () => boolean;
  /** Record the exit status, as `process.exit(code)` does. */
  recordExit: (code: number) => void;
}

/** What Node prints for an unhandled rejection's reason. */
export function formatUnhandledRejection(reason: unknown): string {
  if (reason instanceof Error) return `${reason.stack ?? `${reason.name}: ${reason.message}`}\n`;
  return `Uncaught ${typeof reason === 'string' ? `'${reason}'` : String(reason)}\n`;
}

/**
 * Watch `target` (the realm's global scope) for unhandled rejections. A no-op
 * where the global is no event target (the in-process realm under Node).
 */
export function watchUnhandledRejections(
  target: Partial<RejectionTarget>,
  options: UnhandledRejectionOptions
): UnhandledRejectionWatch {
  let resolveFatal: () => void = () => undefined;
  const fatal = new Promise<void>((resolve) => {
    resolveFatal = resolve;
  });
  if (typeof target.addEventListener !== 'function') {
    return { fatal, dispose: () => undefined };
  }
  const listener = (event: Event): void => {
    const reason = (event as PromiseRejectionEvent).reason;
    // Handled here, never in the console of the worker hosting the realm.
    event.preventDefault();
    // `process.exit()` from async code rejects with NodeExitError after it
    // recorded its code, and after an exit nothing else is reported.
    if (reason instanceof NodeExitError || options.didExit()) return;
    options.writeStderr(formatUnhandledRejection(reason));
    options.recordExit(1);
    resolveFatal();
  };
  target.addEventListener('unhandledrejection', listener);
  return {
    fatal,
    dispose: () => target.removeEventListener?.('unhandledrejection', listener),
  };
}
