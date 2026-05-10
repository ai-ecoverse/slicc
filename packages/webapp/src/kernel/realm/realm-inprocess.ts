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
import { runPyRealm } from './py-realm-shared.js';
import type { RealmPortLike } from './realm-rpc.js';
import type { Realm, RealmFactory } from './realm-runner.js';
import type { RealmInitMsg, RealmErrorMsg } from './realm-types.js';

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
 * In-process Python realm factory. Same pattern as the JS one but
 * dispatches to `runPyRealm`. Used when no DedicatedWorker is
 * available (vitest, headless tools that didn't import the
 * default factory). Cold-start cost is the same ~1-2 s — Pyodide
 * doesn't care that it's running in the same realm as the
 * kernel.
 */
export function createInProcessPyRealmFactory(): RealmFactory {
  return async ({ kind }) => {
    if (kind !== 'py') {
      throw new Error('createInProcessPyRealmFactory: only kind:py is supported');
    }
    const { realmSide, hostSide } = makeInProcessPortPair();
    const initHandler = (event: MessageEvent): void => {
      const data = event.data as { type?: string };
      if (data?.type !== 'realm-init') return;
      realmSide.removeEventListener('message', initHandler);
      const init = event.data as RealmInitMsg;
      if (init.kind !== 'py') return;
      void runPyRealm(init, realmSide).catch((err: unknown) => {
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
