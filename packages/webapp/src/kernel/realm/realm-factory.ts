/**
 * `realm-factory.ts` — selects the right realm impl per `kind`:
 *
 *   - `kind:'js'` → `DedicatedWorker` over `js-realm-worker.ts`
 *     (full eval permissions, no CSP).
 *   - `kind:'py'` → `DedicatedWorker` over `py-realm-worker.ts`
 *     (Pyodide is WASM, only needs `wasm-unsafe-eval`).
 *
 * The factory shape is `(kind, ctx) => Promise<Realm>`. Callers
 * thread it into `runInRealm` so tests can substitute mocks.
 */

import {
  isExtensionRuntime,
  isNodeRuntime,
  resolveNodePackageBaseUrl,
} from '../../shell/supplemental-commands/shared.js';
import { PYODIDE_RUNTIME_CDN } from './py-realm-shared.js';
import { createInProcessJsRealmFactory, createInProcessPyRealmFactory } from './realm-inprocess.js';
import type { RealmPortLike } from './realm-rpc.js';
import type { Realm, RealmFactory } from './realm-runner.js';
import type { RealmKind } from './realm-types.js';

/**
 * Production realm factory. Inspects `kind` and returns the matching
 * impl. Pure dispatcher — testable bits live in the impl files (the
 * worker entries).
 *
 * Fallback chain when the preferred impl isn't available:
 *   - kind:'js' → DedicatedWorker → in-process JS
 *   - kind:'py' → DedicatedWorker → in-process Pyodide
 *
 * In-process is the vitest/headless-node path. SIGKILL becomes
 * cooperative (no `worker.terminate()` to invoke), but the real
 * floats always have Worker available so production keeps the
 * hard-kill guarantee.
 */
const inProcessJs = createInProcessJsRealmFactory();
const inProcessPy = createInProcessPyRealmFactory();

export function createDefaultRealmFactory(): RealmFactory {
  return async ({ kind, ctx }) => {
    if (kind === 'py') {
      if (typeof Worker !== 'undefined') return createPyWorkerRealm();
      return inProcessPy({ kind, ctx });
    }
    // kind === 'js' — always the worker realm (in-process fallback in headless Node).
    if (typeof Worker !== 'undefined') return createJsWorkerRealm();
    return inProcessJs({ kind, ctx });
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
    // Forwards both `error` (worker crash / uncaught bootstrap throw) and
    // `messageerror` (realm posted an un-deserializable message — a worker
    // that died mid-post) so the runner can settle non-zero on either.
    addEventListener: (type, handler, options) =>
      worker.addEventListener(type, handler as EventListener, options),
    removeEventListener: (type, handler) =>
      worker.removeEventListener(type, handler as EventListener),
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
 *
 * Runtime detection MUST go extension → node → browser, in that
 * order. The historical `typeof window === 'undefined'` shortcut
 * misidentifies DedicatedWorkers (no `window`, but still a browser
 * context) as Node and steers them at the local `node_modules`
 * tree, which the Vite dev server returns the SPA fallback for —
 * the worker then tries to load `<!DOCTYPE …>` as a WASM module.
 *
 * Returns `undefined` for the standalone browser float (CLI /
 * wrangler-served webapp / hosted-leader cone). Wave 13c moved that
 * branch off the preview-SW round-trip: `python-command` resolves
 * the ipk-installed `/workspace/node_modules/pyodide/` directory
 * itself and threads it through `RealmInitMsg.pyodideAssetRoot`, and
 * the worker builds a synthetic blob-backed indexURL inside
 * `runPyRealm` (no HTTP origin, no preview-SW dependency, no
 * JSON-parse-of-404-body footgun).
 *
 * The `PYODIDE_RUNTIME_CDN` constant remains the single documented
 * runtime-CDN exception for pyodide's wheel ecosystem only — it is
 * NOT the loader default. Referenced here so the export stays
 * tree-shake-resistant and discoverable from the loader call site.
 */
export function resolvePyodideIndexURL(): string | undefined {
  if (isExtensionRuntime()) {
    const c = (globalThis as { chrome?: { runtime?: { getURL?: (path: string) => string } } })
      .chrome;
    if (c?.runtime?.getURL) return c.runtime.getURL('pyodide/');
  }
  if (isNodeRuntime()) {
    return decodeURIComponent(
      resolveNodePackageBaseUrl('pyodide/pyodide.mjs', '../../../../../node_modules/pyodide/')
        .pathname
    );
  }
  // Reference `PYODIDE_RUNTIME_CDN` so the documented exception stays
  // tree-shake-resistant and discoverable from the loader call site.
  void PYODIDE_RUNTIME_CDN;
  return undefined;
}

export type { Realm, RealmFactory, RealmKind };
