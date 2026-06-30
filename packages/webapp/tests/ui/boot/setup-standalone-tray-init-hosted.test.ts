// @vitest-environment jsdom
/**
 * Regression test: runHostedBootstrap must route through the thin bridge
 * (resolveApiUrl + apiHeaders) so hosted-leader pages served from
 * www.sliccy.ai reach the local node-server instead of the hosted origin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/ui/provider-settings.js', () => ({
  saveOAuthAccount: vi.fn(async () => {}),
  removeAccount: vi.fn(async () => {}),
  addAccount: vi.fn(),
  getAccounts: vi.fn(() => []),
  getProviderConfig: vi.fn(() => ({})),
}));

vi.mock('../../../src/ui/hosted-config-apply.js', () => ({
  applyHostedAccounts: vi.fn(async () => {}),
  prewarmHostedModels: vi.fn(async () => {}),
}));

import { setBridgeToken, setLocalApiBaseUrl } from '../../../src/shell/proxied-fetch.js';
import { runHostedBootstrap } from '../../../src/ui/boot/setup-standalone-tray-init-hosted.js';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
  get length() {
    return store.size;
  },
  key: (_i: number) => null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', fakeStorage);
});

afterEach(() => {
  vi.useRealTimers();
  setLocalApiBaseUrl(null);
  setBridgeToken(null);
  store.clear();
  vi.unstubAllGlobals();
});

describe('runHostedBootstrap — thin-bridge routing', () => {
  it('rewrites URL and attaches X-Bridge-Token when bridge is configured', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('my-bridge-token');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'adobe:claude-opus-4-6',
          accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'tok' }],
        }),
        { status: 200 }
      )
    );

    const done = runHostedBootstrap({ log });
    await vi.advanceTimersByTimeAsync(5500);
    await done;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:5710/api/hosted-bootstrap');
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['X-Bridge-Token']).toBe('my-bridge-token');

    fetchSpy.mockRestore();
  });

  it('sets selected-model from the bootstrap response', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('tok');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'adobe:claude-opus-4-6',
          accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'x' }],
        }),
        { status: 200 }
      )
    );

    const done = runHostedBootstrap({ log });
    await vi.advanceTimersByTimeAsync(5500);
    await done;

    expect(store.get('selected-model')).toBe('adobe:claude-opus-4-6');

    fetchSpy.mockRestore();
  });
});
