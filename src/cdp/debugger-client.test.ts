import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      group: vi.fn().mockResolvedValue(42),
    },
    tabGroups: {
      update: vi.fn().mockResolvedValue(undefined),
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
    const { DebuggerClient } = await import('./debugger-client.js');
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

describe('DebuggerClient tab grouping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function stubChrome(overrides?: {
    group?: ReturnType<typeof vi.fn>;
    tabGroupsUpdate?: ReturnType<typeof vi.fn>;
  }) {
    const chromeMock = {
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue({}),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
        onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 10 }),
        remove: vi.fn().mockResolvedValue(undefined),
        group: overrides?.group ?? vi.fn().mockResolvedValue(42),
      },
      tabGroups: {
        update: overrides?.tabGroupsUpdate ?? vi.fn().mockResolvedValue(undefined),
      },
    };
    vi.stubGlobal('chrome', chromeMock);
    return chromeMock;
  }

  it('creates a new tab group on first Target.createTarget', async () => {
    const chromeMock = stubChrome();
    const { DebuggerClient } = await import('./debugger-client.js');
    const client = new DebuggerClient();
    await client.connect();

    const result = await client.send('Target.createTarget', { url: 'https://example.com' });

    expect(result).toEqual({ targetId: '10' });
    expect(chromeMock.tabs.group).toHaveBeenCalledWith({ tabIds: 10 });
    expect(chromeMock.tabGroups.update).toHaveBeenCalledWith(42, {
      title: 'slicc',
      color: 'pink',
      collapsed: false,
    });
  });

  it('reuses existing group ID on subsequent tab creation', async () => {
    const groupMock = vi.fn().mockResolvedValue(42);
    const chromeMock = stubChrome({ group: groupMock });
    const { DebuggerClient } = await import('./debugger-client.js');
    const client = new DebuggerClient();
    await client.connect();

    // First tab — creates group
    await client.send('Target.createTarget', { url: 'https://one.com' });
    expect(groupMock).toHaveBeenCalledWith({ tabIds: 10 });

    // Second tab — reuses group
    chromeMock.tabs.create.mockResolvedValue({ id: 11 });
    await client.send('Target.createTarget', { url: 'https://two.com' });
    expect(groupMock).toHaveBeenCalledWith({ tabIds: 11, groupId: 42 });
  });

  it('recreates group when previous group was removed by user', async () => {
    const groupMock = vi.fn()
      .mockResolvedValueOnce(42)    // first call — create group
      .mockRejectedValueOnce(new Error('group not found'))  // reuse fails
      .mockResolvedValueOnce(99);   // recreate with new ID
    const updateMock = vi.fn().mockResolvedValue(undefined);
    const chromeMock = stubChrome({ group: groupMock, tabGroupsUpdate: updateMock });
    const { DebuggerClient } = await import('./debugger-client.js');
    const client = new DebuggerClient();
    await client.connect();

    // First tab — creates group 42
    await client.send('Target.createTarget', { url: 'https://one.com' });
    expect(updateMock).toHaveBeenCalledWith(42, expect.objectContaining({ title: 'slicc' }));

    // Second tab — group 42 was removed, falls back to creating group 99
    chromeMock.tabs.create.mockResolvedValue({ id: 11 });
    await client.send('Target.createTarget', { url: 'https://two.com' });
    expect(updateMock).toHaveBeenLastCalledWith(99, expect.objectContaining({ title: 'slicc' }));
  });

  it('does not throw when chrome.tabs.group is unavailable', async () => {
    const groupMock = vi.fn().mockRejectedValue(new Error('API unavailable'));
    stubChrome({ group: groupMock });
    const { DebuggerClient } = await import('./debugger-client.js');
    const client = new DebuggerClient();
    await client.connect();

    // Should not throw — best-effort
    const result = await client.send('Target.createTarget', { url: 'https://example.com' });
    expect(result).toEqual({ targetId: '10' });
  });

  it('does not throw when chrome.tabGroups.update fails', async () => {
    const updateMock = vi.fn().mockRejectedValue(new Error('tabGroups unavailable'));
    stubChrome({ tabGroupsUpdate: updateMock });
    const { DebuggerClient } = await import('./debugger-client.js');
    const client = new DebuggerClient();
    await client.connect();

    // tabs.group succeeds but tabGroups.update fails — should not throw
    const result = await client.send('Target.createTarget', { url: 'https://example.com' });
    expect(result).toEqual({ targetId: '10' });
  });
});