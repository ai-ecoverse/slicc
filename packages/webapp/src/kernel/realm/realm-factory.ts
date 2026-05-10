/**
 * `realm-factory.ts` — selects the right realm impl per
 * `(kind, runtime)`:
 *
 *   - `kind:'js'` + standalone → `DedicatedWorker` over
 *     `js-realm-worker.ts` (full eval permissions, no CSP).
 *   - `kind:'js'` + extension → per-task sandbox iframe via
 *     `createIframeRealm` (offscreen CSP blocks AsyncFunction in
 *     workers).
 *   - `kind:'py'` + both → `DedicatedWorker` over
 *     `py-realm-worker.ts` (Pyodide is WASM, only needs
 *     `wasm-unsafe-eval` which both modes grant).
 *
 * The factory shape is `(kind, ctx) => Promise<Realm>`. Callers
 * thread it into `runInRealm` so tests can substitute mocks.
 */

import type { CommandContext } from 'just-bash';
import { createIframeRealm } from './realm-iframe.js';
import { resolveNodePackageBaseUrl } from '../../shell/supplemental-commands/shared.js';
import { PYODIDE_CDN } from './py-realm-shared.js';
import type { Realm, RealmFactory } from './realm-runner.js';
import type { RealmKind } from './realm-types.js';
import type { RealmPortLike } from './realm-rpc.js';

/**
 * Production realm factory. Inspects runtime + `kind` and returns
 * the matching impl. Pure dispatcher — testable bits live in the
 * impl files (`createIframeRealm`, the worker entries).
 */
export function createDefaultRealmFactory(): RealmFactory {
  return async ({ kind, ctx }) => {
    if (kind === 'py') return createPyWorkerRealm();
    // kind === 'js'
    if (isExtension()) return createIframeRealm(kind, ctx);
    return createJsWorkerRealm();
  };
}

// ---------------------------------------------------------------------------
// Worker impls (standalone JS, both-mode Python)
// ---------------------------------------------------------------------------

function createJsWorkerRealm(): Realm {
  if (typeof Worker === 'undefined') {
    throw new Error('realm-factory: Worker is not available in this runtime');
  }
  const worker = new Worker(new URL('./js-realm-worker.ts', import.meta.url), { type: 'module' });
  return wrapWorker(worker);
}

function createPyWorkerRealm(): Realm {
  if (typeof Worker === 'undefined') {
    throw new Error('realm-factory: Worker is not available in this runtime');
  }
  const worker = new Worker(new URL('./py-realm-worker.ts', import.meta.url), { type: 'module' });
  // The Python worker reads `pyodideIndexURL` from the init
  // message; the kernel side picks the right URL based on runtime
  // (extension → bundled, node → node_modules, browser → CDN).
  return wrapWorker(worker);
}

function wrapWorker(worker: Worker): Realm {
  const port: RealmPortLike = {
    postMessage: (msg, transfer) =>
      transfer ? worker.postMessage(msg, transfer) : worker.postMessage(msg),
    addEventListener: (type, handler) => worker.addEventListener(type, handler),
    removeEventListener: (type, handler) => worker.removeEventListener(type, handler),
  };
  let terminated = false;
  return {
    controlPort: port,
    addEventListener: (type, handler, options) => worker.addEventListener(type, handler, options),
    removeEventListener: (type, handler) => worker.removeEventListener(type, handler),
    terminate(): void {
      if (terminated) return;
      terminated = true;
      try {
        worker.terminate();
      } catch {
        /* idempotent */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pyodide URL resolution
// ---------------------------------------------------------------------------

/**
 * Pick the Pyodide indexURL for the current runtime. Used by
 * `python-command` to populate `RealmInitMsg.pyodideIndexURL` so
 * the worker side stays runtime-agnostic.
 */
export function resolvePyodideIndexURL(): string {
  if (typeof window === 'undefined') {
    return decodeURIComponent(
      resolveNodePackageBaseUrl('pyodide/pyodide.mjs', '../../../../../node_modules/pyodide/')
        .pathname
    );
  }
  if (isExtension()) {
    const c = (globalThis as { chrome?: { runtime?: { getURL?: (path: string) => string } } })
      .chrome;
    if (c?.runtime?.getURL) return c.runtime.getURL('pyodide/');
  }
  return PYODIDE_CDN;
}

function isExtension(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    !!(chrome as { runtime?: { id?: string } } | undefined)?.runtime?.id
  );
}

export type { RealmFactory, Realm, RealmKind };
