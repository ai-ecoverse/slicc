import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebuggerClient } from './debugger-client.js';

describe('DebuggerClient', () => {
  const makeChrome = () => ({
    debugger: {
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({}),
      onEvent: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      onDetach: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 7 }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  });

  beforeEach(() => {
    vi.stubGlobal('chrome', makeChrome());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('closes tabs via chrome.tabs.remove and clears session mappings', async () => {
    const client = new DebuggerClient();
    await client.connect();

    const attachResult = await client.send('Target.attachToTarget', {
      targetId: '7',
      flatten: true,
    });

    expect(attachResult).toEqual({ sessionId: '7' });

    const result = await client.send('Target.closeTarget', { targetId: '7' });

    expect(result).toEqual({ success: true });
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 7 });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(7);
    await expect(client.send('Page.enable', {}, '7')).rejects.toThrow(/Attach to a target first/);
  });
});