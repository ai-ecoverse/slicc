import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNonRetryableError } from '../../src/scoops/scoop-context.js';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
  get length() {
    return storage.size;
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  clear: () => storage.clear(),
});

const SESSION_EXPIRED = 'Adobe session expired — please log in again';

function seedAdobeAccount(tokenExpiresAt: number): void {
  storage.set(
    'slicc_accounts',
    JSON.stringify([
      {
        providerId: 'adobe',
        apiKey: 'cached-access-token',
        accessToken: 'cached-access-token',
        tokenExpiresAt,
      },
    ])
  );
}

function installPanelRpcBridge(handler: (op: string, payload: unknown) => unknown): void {
  (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = {
    call: vi.fn(async (op: string, payload?: unknown) => handler(op, payload)),
    onEvent: () => () => {},
    registerPushTarget: () => {},
    unregisterPushTarget: () => {},
    dispose: () => {},
  };
}

describe('issue #1181: Adobe session expiry in the worker realm', () => {
  beforeEach(() => {
    storage.clear();

    vi.resetModules();
    delete (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
  });

  afterEach(() => {
    delete (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
  });

  it('has no DOM — the worker-realm precondition the bug depends on', () => {
    expect(typeof window).toBe('undefined');
  });

  it('renews via the panel-RPC bridge when the page can silently refresh the token (the #1181 fix)', async () => {
    seedAdobeAccount(Date.now() - 60_000);
    installPanelRpcBridge((op) => {
      if (op === 'silent-renew') return { accessToken: 'renewed-access-token' };
      throw new Error(`unexpected op ${op}`);
    });
    const { getValidAccessToken } = await import('../../providers/adobe.js');

    await expect(getValidAccessToken()).resolves.toBe('renewed-access-token');
  });

  it('forwards the adobe providerId to the bridge silent-renew op', async () => {
    seedAdobeAccount(Date.now() - 60_000);
    let seenOp: string | undefined;
    let seenPayload: unknown;
    installPanelRpcBridge((op, payload) => {
      seenOp = op;
      seenPayload = payload;
      return { accessToken: 'renewed-access-token' };
    });
    const { getValidAccessToken } = await import('../../providers/adobe.js');

    await getValidAccessToken();
    expect(seenOp).toBe('silent-renew');
    expect(seenPayload).toEqual({ providerId: 'adobe' });
  });

  it('still surfaces session-expired when no page bridge is available to renew', async () => {
    seedAdobeAccount(Date.now() - 60_000);

    const { getValidAccessToken } = await import('../../providers/adobe.js');

    await expect(getValidAccessToken()).rejects.toThrow(SESSION_EXPIRED);
  });

  it('classifies the no-bridge surfaced error as non-retryable, producing the wrapped cone error', async () => {
    seedAdobeAccount(Date.now() - 60_000);
    const { getValidAccessToken } = await import('../../providers/adobe.js');

    const message = await getValidAccessToken().then(
      () => {
        throw new Error('expected getValidAccessToken to reject');
      },
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );

    expect(isNonRetryableError(message)).toBe(true);

    const wrapped = `Scoop "Cone" failed with unrecoverable error: ${message}`;
    expect(wrapped).toBe(
      'Scoop "Cone" failed with unrecoverable error: Adobe session expired — please log in again'
    );
  });

  it('control: a still-valid token is returned without attempting renewal', async () => {
    seedAdobeAccount(Date.now() + 10 * 60_000);
    const { getValidAccessToken } = await import('../../providers/adobe.js');

    await expect(getValidAccessToken()).resolves.toBe('cached-access-token');
  });
});
