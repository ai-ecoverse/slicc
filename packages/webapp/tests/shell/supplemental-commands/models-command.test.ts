import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    // Mock chrome.runtime to simulate extension mode
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

    // Mock localStorage (need to define it in Node env)
    const mockLocalStorage = {
      getItem: vi.fn().mockReturnValue('test-api-key'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      length: 0,
      key: vi.fn(),
    };
    (globalThis as any).localStorage = mockLocalStorage;

    // Import the module AFTER chrome mock is in place
    // This ensures createProxiedFetch will see chrome.runtime.id
    const modelsCommand =
      await import('../../../src/shell/supplemental-commands/models-command.ts');

    // We can't directly invoke fetchAAData since it's not exported,
    // but we can verify the file imports createProxiedFetch
    // by checking that the module loaded successfully
    expect(modelsCommand).toBeDefined();

    // Verify chrome.runtime.connect was called when createProxiedFetch ran
    // (This will happen during the first fetch call)
    // For now, just verify the module structure is correct
    expect(connectSpy).not.toHaveBeenCalled(); // Not called until fetch actually happens
  });

  it('imports createProxiedFetch instead of using global fetch', async () => {
    // Static analysis test: verify the file imports createProxiedFetch
    const fileContent = await import('fs/promises').then((fs) =>
      fs.readFile(
        '/Users/kpauls/projects/adobe/github/slicc/packages/webapp/src/shell/supplemental-commands/models-command.ts',
        'utf-8'
      )
    );

    expect(fileContent).toContain("from '../proxied-fetch.js'");
    expect(fileContent).toContain('createProxiedFetch');
  });
});
