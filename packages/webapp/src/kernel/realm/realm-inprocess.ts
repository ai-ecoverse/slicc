import { runJsRealm } from './js-realm-shared.js';
import { runPyRealm } from './py-realm-shared.js';
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
      void runJsRealm(init, realmSide).catch((err: unknown) => {
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

export function createInProcessRealmFactory(): RealmFactory {
  const js = createInProcessJsRealmFactory();
  const py = createInProcessPyRealmFactory();
  return async (args) => (args.kind === 'js' ? js(args) : py(args));
}
