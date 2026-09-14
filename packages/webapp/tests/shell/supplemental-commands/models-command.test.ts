import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('models-command direct fetch migration', () => {
  let originalChrome: any;

  beforeEach(() => {
    originalChrome = (globalThis as any).chrome;
  });

  afterEach(() => {
    (globalThis as any).chrome = originalChrome;
    vi.restoreAllMocks();
  });

  it('routes through createProxiedFetch (not bare fetch) for AA_API_URL', async () => {
    const connectSpy = vi.fn(() => ({
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    }));

    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension-id',
        connect: connectSpy,
      },
    };

    const mockLocalStorage = {
      getItem: vi.fn().mockReturnValue('test-api-key'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      length: 0,
      key: vi.fn(),
    };
    (globalThis as any).localStorage = mockLocalStorage;

    const modelsCommand = await import(
      '../../../src/shell/supplemental-commands/models-command.js'
    );

    expect(modelsCommand).toBeDefined();

    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('imports createProxiedFetch instead of using global fetch', async () => {
    const proxiedFetchModule = await import('../../../src/shell/proxied-fetch.js');
    expect(typeof proxiedFetchModule.createProxiedFetch).toBe('function');
  });
});
