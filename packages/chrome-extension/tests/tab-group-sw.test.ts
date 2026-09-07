/**
 * Tests for the "slicc" tab-grouping helper extracted out of service-worker.ts.
 *
 * Grouping is cosmetic and best-effort: `addToSliccGroup` must never throw, so
 * a CDP `Target.createTarget` still succeeds when tab groups are unavailable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface GroupCall {
  tabIds: number | number[];
  groupId?: number;
}

let groupCalls: GroupCall[];
let groupImpl: (options: GroupCall) => Promise<number>;
let tabGroupsUpdate: ReturnType<typeof vi.fn>;

async function loadModule(): Promise<typeof import('../src/tab-group-sw.js')> {
  vi.resetModules();
  return import('../src/tab-group-sw.js');
}

beforeEach(() => {
  groupCalls = [];
  let nextGroupId = 100;
  groupImpl = async () => nextGroupId++;
  tabGroupsUpdate = vi.fn(async () => undefined);

  (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
    tabs: {
      group: vi.fn(async (options: GroupCall) => {
        groupCalls.push(options);
        return groupImpl(options);
      }),
    },
    tabGroups: { update: tabGroupsUpdate },
  };
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('addToSliccGroup', () => {
  it('creates the pink "slicc" group on the first tab', async () => {
    const { addToSliccGroup } = await loadModule();

    await addToSliccGroup(11);

    expect(groupCalls).toEqual([{ tabIds: 11 }]);
    expect(tabGroupsUpdate).toHaveBeenCalledWith(100, {
      title: 'slicc',
      color: 'pink',
      collapsed: false,
    });
  });

  it('reuses the cached group id for later tabs instead of creating a second group', async () => {
    const { addToSliccGroup } = await loadModule();

    await addToSliccGroup(11);
    await addToSliccGroup(12);
    await addToSliccGroup(13);

    expect(groupCalls).toEqual([
      { tabIds: 11 },
      { tabIds: 12, groupId: 100 },
      { tabIds: 13, groupId: 100 },
    ]);
    // Only the initial creation names/colors the group.
    expect(tabGroupsUpdate).toHaveBeenCalledTimes(1);
  });

  it('recreates the group when the user has dismissed the cached one', async () => {
    const { addToSliccGroup } = await loadModule();
    await addToSliccGroup(11);

    // Adding to the remembered group fails once (group gone), then a fresh
    // create succeeds.
    let calls = 0;
    groupImpl = async (options) => {
      calls++;
      if (options.groupId !== undefined) throw new Error('No group with id 100');
      return 200;
    };

    await addToSliccGroup(12);

    expect(calls).toBe(2);
    expect(groupCalls.at(-1)).toEqual({ tabIds: 12 });
    expect(tabGroupsUpdate).toHaveBeenLastCalledWith(200, {
      title: 'slicc',
      color: 'pink',
      collapsed: false,
    });
  });

  it('swallows a grouping failure so the caller still succeeds', async () => {
    const { addToSliccGroup } = await loadModule();
    groupImpl = async () => {
      throw new Error('Tab groups unavailable');
    };

    await expect(addToSliccGroup(11)).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Tab grouping failed'),
      expect.objectContaining({ tabId: 11, error: 'Tab groups unavailable' })
    );
  });

  it('swallows a tabGroups.update failure after the group was created', async () => {
    const { addToSliccGroup } = await loadModule();
    tabGroupsUpdate.mockRejectedValue(new Error('no such group'));

    await expect(addToSliccGroup(11)).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Tab grouping failed'),
      expect.objectContaining({ tabId: 11, error: 'no such group' })
    );
  });
});
