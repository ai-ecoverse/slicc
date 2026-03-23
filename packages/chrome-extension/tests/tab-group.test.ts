import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('addToSliccGroup', () => {
  function stubChrome(overrides?: {
    group?: ReturnType<typeof vi.fn>;
    tabGroupsUpdate?: ReturnType<typeof vi.fn>;
  }) {
    const chromeMock = {
      tabs: {
        group: overrides?.group ?? vi.fn().mockResolvedValue(42),
      },
      tabGroups: {
        update: overrides?.tabGroupsUpdate ?? vi.fn().mockResolvedValue(undefined),
      },
    };
    vi.stubGlobal('chrome', chromeMock);
    return chromeMock;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates a new tab group on first call', async () => {
    const chromeMock = stubChrome();
    const { addToSliccGroup } = await import('../src/tab-group.js');

    await addToSliccGroup(10);

    expect(chromeMock.tabs.group).toHaveBeenCalledWith({ tabIds: 10 });
    expect(chromeMock.tabGroups.update).toHaveBeenCalledWith(42, {
      title: 'slicc',
      color: 'pink',
      collapsed: false,
    });
  });

  it('reuses the existing group ID on subsequent calls', async () => {
    const groupMock = vi.fn().mockResolvedValue(42);
    const chromeMock = stubChrome({ group: groupMock });
    const { addToSliccGroup } = await import('../src/tab-group.js');

    await addToSliccGroup(10);
    expect(groupMock).toHaveBeenCalledWith({ tabIds: 10 });

    await addToSliccGroup(11);
    expect(groupMock).toHaveBeenCalledWith({ tabIds: 11, groupId: 42 });

    // update only called once (on first group creation)
    expect(chromeMock.tabGroups.update).toHaveBeenCalledTimes(1);
  });

  it('recreates the group when the previous group was removed by user', async () => {
    const groupMock = vi
      .fn()
      .mockResolvedValueOnce(42) // first: create group 42
      .mockRejectedValueOnce(new Error('group not found')) // reuse 42 fails
      .mockResolvedValueOnce(99); // recreate as group 99
    const updateMock = vi.fn().mockResolvedValue(undefined);
    stubChrome({ group: groupMock, tabGroupsUpdate: updateMock });
    const { addToSliccGroup } = await import('../src/tab-group.js');

    // First tab — creates group 42
    await addToSliccGroup(10);
    expect(updateMock).toHaveBeenCalledWith(42, expect.objectContaining({ title: 'slicc' }));

    // Second tab — group 42 removed, falls back to creating group 99
    await addToSliccGroup(11);
    expect(updateMock).toHaveBeenLastCalledWith(99, expect.objectContaining({ title: 'slicc' }));
  });

  it('does not throw when chrome.tabs.group fails completely', async () => {
    stubChrome({ group: vi.fn().mockRejectedValue(new Error('API unavailable')) });
    const { addToSliccGroup } = await import('../src/tab-group.js');

    await expect(addToSliccGroup(10)).resolves.toBeUndefined();
  });

  it('does not throw when chrome.tabGroups.update fails', async () => {
    stubChrome({ tabGroupsUpdate: vi.fn().mockRejectedValue(new Error('no tabGroups')) });
    const { addToSliccGroup } = await import('../src/tab-group.js');

    await expect(addToSliccGroup(10)).resolves.toBeUndefined();
  });

  it('resets state via _resetGroupState', async () => {
    const groupMock = vi.fn().mockResolvedValue(42);
    stubChrome({ group: groupMock });
    const { addToSliccGroup, _resetGroupState } = await import('../src/tab-group.js');

    await addToSliccGroup(10);
    expect(groupMock).toHaveBeenLastCalledWith({ tabIds: 10 });

    await addToSliccGroup(11);
    expect(groupMock).toHaveBeenLastCalledWith({ tabIds: 11, groupId: 42 });

    // After reset, next call should create a new group (no groupId)
    _resetGroupState();
    await addToSliccGroup(12);
    expect(groupMock).toHaveBeenLastCalledWith({ tabIds: 12 });
  });
});
