import {
  isNodeRuntime,
  resolveNodePackageBaseUrl,
} from '../../shell/supplemental-commands/shared.js';
import { PYODIDE_RUNTIME_CDN } from './py-realm-shared.js';
import type { RealmPortLike } from './realm-rpc.js';
import type { Realm, RealmFactory } from './realm-runner.js';
import type { RealmKind } from './realm-types.js';

let inProcessJs: RealmFactory | undefined;
let inProcessPy: RealmFactory | undefined;

export function createDefaultRealmFactory(): RealmFactory {
  return async ({ kind, ctx }) => {
    if (kind === 'py') {
      if (typeof Worker !== 'undefined') return createPyWorkerRealm();
      if (!inProcessPy) {
        const { createInProcessPyRealmFactory } = await import('./realm-inprocess.js');
        inProcessPy = createInProcessPyRealmFactory();
      }
      return inProcessPy({ kind, ctx });
    }

    if (typeof Worker !== 'undefined') return createJsWorkerRealm();
    if (!inProcessJs) {
      const { createInProcessJsRealmFactory } = await import('./realm-inprocess.js');
      inProcessJs = createInProcessJsRealmFactory();
    }
    return inProcessJs({ kind, ctx });
  };
}

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

    isolatedThread: true,

    addEventListener: (type, handler, options) =>
      worker.addEventListener(type, handler as EventListener, options),
    removeEventListener: (type, handler) =>
      worker.removeEventListener(type, handler as EventListener),
    terminate(): void {
      if (terminated) return;
      terminated = true;
      try {
        worker.terminate();
      } catch {}
    },
  };
}

export function resolvePyodideIndexURL(): string | undefined {
  if (isNodeRuntime()) {
    return decodeURIComponent(
      resolveNodePackageBaseUrl('pyodide/pyodide.mjs', '../../../../../node_modules/pyodide/')
        .pathname
    );
  }

  void PYODIDE_RUNTIME_CDN;
  return undefined;
}

export type { Realm, RealmFactory, RealmKind };
