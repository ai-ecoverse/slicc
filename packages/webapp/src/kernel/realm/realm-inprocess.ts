/**
 * `realm-inprocess.ts` — non-isolating realm factory used in
 * environments where neither `DedicatedWorker` nor a sandbox
 * iframe is available (vitest, headless node-server tooling). The
 * code executes IN-PROCESS via the same `runJsRealm` engine the
 * standalone worker uses; the only difference is the kernel side
 * runs inside the same realm, so `worker.terminate()`-style hard
 * kill is NOT possible. SIGKILL during a runaway loop will hang
 * the kernel — same as the legacy AsyncFunction path. Production
 * always uses the worker / iframe factories instead.
 *
 * Wire-up: a `MessageChannel`-style fake port pair connects the
 * realm's RPC client to the kernel's RPC host. Posts on either
 * port immediately deliver to the other side's listeners (no
 * actual cross-thread boundary).
 */

import { runJsRealm } from './js-realm-shared.js';
import { PyRealmSession } from './py-realm-shared.js';
import type { RealmPortLike } from './realm-rpc.js';
import type { Realm, RealmFactory } from './realm-runner.js';
import type { RealmErrorMsg, RealmInitMsg } from './realm-types.js';

interface PortPair {
  realmSide: RealmPortLike;
  hostSide: RealmPortLike;
}

function makeInProcessPortPair(): PortPair {
  const realmListeners = new Set<(event: MessageEvent) => void>();
  const hostListeners = new Set<(event: MessageEvent) => void>();
  const realmSide: RealmPortLike = {
    postMessage: (msg) => {
      // Realm → host. Defer to a microtask so the realm-side
      // postMessage doesn't synchronously re-enter the host before
      // the realm-side runner has completed its current step.
      queueMicrotask(() => {
        for (const h of [...hostListeners]) h({ data: msg } as MessageEvent);
      });
    },
    addEventListener: (_type, handler) => {
      realmListeners.add(handler);
    },
    removeEventListener: (_type, handler) => {
      realmListeners.delete(handler);
    },
  };
  const hostSide: RealmPortLike = {
    postMessage: (msg) => {
      // Host → realm.
      queueMicrotask(() => {
        for (const h of [...realmListeners]) h({ data: msg } as MessageEvent);
      });
    },
    addEventListener: (_type, handler) => {
      hostListeners.add(handler);
    },
    removeEventListener: (_type, handler) => {
      hostListeners.delete(handler);
    },
  };
  return { realmSide, hostSide };
}

/**
 * In-process JS realm factory. The `controlPort` returned to the
 * kernel runner is the host side of the pair; the realm side
 * listens for `realm-init` and runs the code via `runJsRealm`.
 *
 * `terminate()` is a no-op — there's no hard-kill in process. A
 * runaway loop hangs the same realm that hosts the kernel.
 */
export function createInProcessJsRealmFactory(): RealmFactory {
  return async ({ kind }) => {
    if (kind !== 'js') {
      throw new Error('createInProcessJsRealmFactory: only kind:js is supported');
    }
    const { realmSide, hostSide } = makeInProcessPortPair();
    const initHandler = (event: MessageEvent): void => {
      const data = event.data as { type?: string };
      if (data?.type !== 'realm-init') return;
      realmSide.removeEventListener('message', initHandler);
      const init = event.data as RealmInitMsg;
      if (init.kind !== 'js') return;
      const failingLoadModule = (id: string): Promise<Record<string, unknown>> =>
        Promise.reject(new Error(`in-process realm: require('${id}') is not pre-loaded`));
      void runJsRealm(init, realmSide, failingLoadModule).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const errMsg: RealmErrorMsg = { type: 'realm-error', message };
        realmSide.postMessage(errMsg);
      });
    };
    realmSide.addEventListener('message', initHandler);
    return {
      controlPort: hostSide,
      terminate(): void {
        realmSide.removeEventListener('message', initHandler);
      },
    } satisfies Realm;
  };
}

/**
 * In-process Python realm factory. Mirrors the warm-reuse worker
 * (`py-realm-worker.ts`): the realm-side listener stays attached and
 * hosts a single `PyRealmSession` across many `realm-init` messages,
 * so the pool can check the same in-process realm out repeatedly
 * (state reset between runs). Used when no DedicatedWorker is
 * available (vitest, headless tools that didn't import the default
 * factory).
 *
 * `loaderImport` lets tests inject a fake Pyodide instead of paying
 * the real ~1-2 s cold boot; production callers omit it and the
 * session dynamically imports `pyodide`.
 *
 * `terminate()` detaches the listener (there's no worker to kill in
 * process). After eviction the pool creates a fresh in-process realm
 * on the next checkout, which boots a new session.
 */
export function createInProcessPyRealmFactory(
  loaderImport?: () => Promise<typeof import('pyodide')>
): RealmFactory {
  return async ({ kind }) => {
    if (kind !== 'py') {
      throw new Error('createInProcessPyRealmFactory: only kind:py is supported');
    }
    const { realmSide, hostSide } = makeInProcessPortPair();
    let sessionPromise: Promise<PyRealmSession> | null = null;
    let busy = false;
    const initHandler = (event: MessageEvent): void => {
      const data = event.data as { type?: string };
      if (data?.type !== 'realm-init') return;
      const init = event.data as RealmInitMsg;
      if (init.kind !== 'py') return;
      if (busy) return;
      busy = true;
      void (async () => {
        let session: PyRealmSession;
        try {
          if (!sessionPromise) sessionPromise = PyRealmSession.create(init, loaderImport);
          session = await sessionPromise;
        } catch (err) {
          sessionPromise = null;
          const message = err instanceof Error ? err.message : String(err);
          const errMsg: RealmErrorMsg = {
            type: 'realm-error',
            message: `loadPyodide: ${message}`,
          };
          realmSide.postMessage(errMsg);
          return;
        }
        try {
          await session.run(init, realmSide);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const errMsg: RealmErrorMsg = { type: 'realm-error', message };
          realmSide.postMessage(errMsg);
        }
      })().finally(() => {
        busy = false;
      });
    };
    realmSide.addEventListener('message', initHandler);
    return {
      controlPort: hostSide,
      terminate(): void {
        realmSide.removeEventListener('message', initHandler);
      },
    } satisfies Realm;
  };
}

/**
 * Picks the right in-process factory by kind. Useful as a unified
 * fallback when `Worker` isn't available — e.g. in
 * `realm-factory.ts`'s default factory when running in node /
 * vitest.
 */
export function createInProcessRealmFactory(): RealmFactory {
  const js = createInProcessJsRealmFactory();
  const py = createInProcessPyRealmFactory();
  return async (args) => (args.kind === 'js' ? js(args) : py(args));
}
