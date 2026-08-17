// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import {
  SYNC_FS_NEED_NONCE_MSG,
  SYNC_FS_NONCE_MSG,
} from '../../../src/kernel/realm/sync-fs-wire.js';
import { setupSyncFsBootNonce } from '../../../src/ui/wc/wc-live-sync-fs.js';

function makeEnvironment(controlled = true) {
  const serviceWorker = new EventTarget() as unknown as ServiceWorkerContainer;
  const postMessage = vi.fn();
  Object.defineProperty(serviceWorker, 'controller', {
    configurable: true,
    value: controlled ? { postMessage } : null,
  });
  const navigator = { serviceWorker } as unknown as Navigator;
  const document = new EventTarget() as unknown as Document;
  let visibilityState: DocumentVisibilityState = 'hidden';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
  const window = new EventTarget() as unknown as Window;
  return {
    navigator,
    document,
    window,
    postMessage,
    show: () => {
      visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

describe('setupSyncFsBootNonce', () => {
  it('stays disabled without a controlling service worker', () => {
    const env = makeEnvironment(false);
    const state = setupSyncFsBootNonce({ ...env, randomUUID: () => 'unused' });
    expect(state).toEqual({ syncFsBridgeEnabled: false, syncFsChannelNonce: undefined });
    expect(env.postMessage).not.toHaveBeenCalled();
  });

  it('publishes one nonce initially and re-publishes on every recovery signal', () => {
    const env = makeEnvironment();
    const state = setupSyncFsBootNonce({ ...env, randomUUID: () => 'boot-nonce' });
    const message = { type: SYNC_FS_NONCE_MSG, nonce: 'boot-nonce' };
    expect(state).toEqual({ syncFsBridgeEnabled: true, syncFsChannelNonce: 'boot-nonce' });
    expect(env.postMessage).toHaveBeenCalledWith(message);

    env.navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
    env.navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: SYNC_FS_NEED_NONCE_MSG } })
    );
    env.show();
    env.window.dispatchEvent(new Event('focus'));

    expect(env.postMessage).toHaveBeenCalledTimes(5);
    expect(env.postMessage).toHaveBeenLastCalledWith(message);
  });
});
