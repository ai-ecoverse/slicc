/**
 * Both `WorkUnitClient` adapters against one conformance suite, plus the
 * cross-transport parity claims that are only meaningful with both in hand
 * (#2274).
 */

import { describe, expect, it } from 'vitest';
import { isReadOnlyRole } from '../../../src/ui/wc/wc-unit-context.js';
import { toTabDescriptors } from '../../../src/work-unit/client/presentation.js';
import { ROSTER, runWorkUnitClientConformance } from './conformance.js';
import { type FakeUnit, makeLocalHarness, makeRemoteHarness } from './fakes.js';

runWorkUnitClientConformance('LocalWorkUnitClient (fake kernel)', makeLocalHarness);
runWorkUnitClientConformance('RemoteWorkUnitClient (fake tray)', makeRemoteHarness);

const color = (unit: { isRoot: boolean; name: string }): string =>
  unit.isRoot ? '#cone' : `#${unit.name}`;

describe('leader and follower render one roster identically (#2274)', () => {
  it('produces byte-identical tab descriptors from the two native shapes', async () => {
    const local = makeLocalHarness();
    const remote = makeRemoteHarness();
    local.setRoster(ROSTER, 'cone_2');
    remote.setRoster(ROSTER, 'cone_2');
    const leader = toTabDescriptors(await local.client.list(), 'cone_2', color);
    const follower = toTabDescriptors(await remote.client.list(), 'cone_2', color);
    expect(follower).toEqual(leader);
  });

  it('agrees on the read-only rule for a child on both sides (#2312)', async () => {
    const local = makeLocalHarness();
    const remote = makeRemoteHarness();
    local.setRoster(ROSTER);
    remote.setRoster(ROSTER);
    for (const client of [local.client, remote.client]) {
      const units = await client.list();
      const roles = new Map(units.map((unit) => [unit.id, unit.role]));
      expect(isReadOnlyRole(roles.get('scoop_1') === 'primary' ? 'cone' : 'scoop')).toBe(true);
      expect(isReadOnlyRole(roles.get('cone_1') === 'primary' ? 'cone' : 'scoop')).toBe(false);
    }
  });

  it('does not invent a root when the leader omits parentId (#2358 stage 3)', async () => {
    const remote = makeRemoteHarness();
    // A leader that predates the ownership edge leaves parentId absent. After
    // stage 3 that unit is unknown — never promoted to a cone.
    const legacy: FakeUnit[] = ROSTER.map((unit) => ({ ...unit, legacyWire: true }));
    remote.setRoster(legacy, 'cone_1');
    const units = await remote.client.list();
    expect(units.every((unit) => unit.role === 'child')).toBe(true);
    expect(units.find((unit) => unit.id === 'scoop_1')?.parentId).toBeUndefined();
  });

  it('resolves roles from the ownership edge alone (#2358)', async () => {
    const remote = makeRemoteHarness();
    remote.setRoster(ROSTER, 'cone_1');
    const units = await remote.client.list();
    expect(units.map((unit) => unit.role)).toEqual(['primary', 'primary', 'child']);
    expect(units.find((unit) => unit.id === 'scoop_1')?.parentId).toBe('cone_2');
    expect(toTabDescriptors(units, 'cone_1', color).map((tab) => tab.key)).toEqual([
      'cone_1',
      'cone_2',
      'scoop_1',
    ]);
  });

  it('keeps a unit whose owner is unknown at the tail rather than dropping it', async () => {
    const remote = makeRemoteHarness();
    const mixed: FakeUnit[] = [
      ROSTER[0],
      { ...ROSTER[2], id: 'scoop_orphan', name: 'orphan', parentId: 'gone' },
    ];
    remote.setRoster(mixed, 'cone_1');
    const keys = toTabDescriptors(await remote.client.list(), 'cone_1', color).map(
      (tab) => tab.key
    );
    expect(keys).toEqual(['cone_1', 'scoop_orphan']);
  });
});
