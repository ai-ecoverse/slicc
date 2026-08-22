import { describe, expect, it } from 'vitest';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import {
  defaultRootOf,
  isReadOnlyRole,
  orderForSwitcher,
  rootFolderForContext,
  rootForConeFolder,
  rootForSelection,
  switcherLabelFor,
  threadContextFor,
  unitForContext,
  unitRoleFor,
  unitSlugFor,
} from '../../../src/ui/wc/wc-unit-context.js';

function unit(over: Partial<RegisteredScoop>): RegisteredScoop {
  return {
    jid: over.jid ?? 'jid',
    name: 'Name',
    folder: 'folder',
    isCone: over.parentJid === null,
    type: over.parentJid === null ? 'cone' : 'scoop',
    requiresTrigger: false,
    assistantLabel: 'label',
    addedAt: '2026-01-01T00:00:00.000Z',
    parentJid: 'cone_1',
    ...over,
  };
}

const primary = unit({
  jid: 'cone_1',
  parentJid: null,
  folder: 'cone',
  name: 'Cone',
  assistantLabel: 'sliccy',
});
const research = unit({
  jid: 'cone_2',
  parentJid: null,
  folder: 'cone-research',
  name: 'Research',
  assistantLabel: 'Research',
  addedAt: '2026-01-02T00:00:00.000Z',
});
const worker = unit({
  jid: 'scoop_1',
  folder: 'worker-scoop',
  name: 'worker',
  assistantLabel: 'worker',
});
const helper = unit({
  jid: 'scoop_2',
  parentJid: 'cone_2',
  folder: 'helper-scoop',
  name: 'helper',
  assistantLabel: 'helper',
});

describe('wc-unit-context', () => {
  it('reads a unit’s role off the ownership edge and makes only scoops read-only (#2312)', () => {
    expect(unitRoleFor(primary)).toBe('cone');
    expect(unitRoleFor(research)).toBe('cone');
    expect(unitRoleFor(worker)).toBe('scoop');
    expect(isReadOnlyRole('cone')).toBe(false);
    expect(isReadOnlyRole('scoop')).toBe(true);
  });

  it('labels roots by assistant label and children by name', () => {
    expect(switcherLabelFor(primary)).toBe('sliccy');
    expect(switcherLabelFor(research)).toBe('Research');
    expect(switcherLabelFor(worker)).toBe('worker');
  });

  it('keeps the primary cone on the historical context and slug', () => {
    expect(threadContextFor(primary)).toBe('cone');
    expect(unitSlugFor(primary)).toBe('cone');
    expect(threadContextFor(research)).toBe('cone:cone-research');
    expect(unitSlugFor(research)).toBe('cone-research');
    expect(threadContextFor(worker)).toBe('scoop:worker');
    expect(unitSlugFor(worker)).toBe('worker');
  });

  it('resolves every context shape back to its unit', () => {
    const all = [worker, research, primary, helper];
    expect(unitForContext(all, 'cone')?.jid).toBe('cone_1');
    expect(unitForContext(all, 'cone:cone-research')?.jid).toBe('cone_2');
    expect(unitForContext(all, 'cone:nope')).toBeUndefined();
    expect(unitForContext(all, 'scoop:helper')?.jid).toBe('scoop_2');
    expect(unitForContext(all, 'scoop:cone')).toBeUndefined();
    // an unknown plain context falls back to the default root
    expect(unitForContext(all, 'whatever')?.jid).toBe('cone_1');
  });

  it('prefers the primary root, else the oldest root, as default', () => {
    expect(defaultRootOf([worker, research, primary])?.jid).toBe('cone_1');
    expect(defaultRootOf([worker, research])?.jid).toBe('cone_2');
    expect(defaultRootOf([worker])).toBeUndefined();
  });

  it('orders roots (oldest first) ahead of children in registry order', () => {
    expect(orderForSwitcher([helper, research, worker, primary]).map((s) => s.jid)).toEqual([
      'cone_1',
      'cone_2',
      'scoop_2',
      'scoop_1',
    ]);
  });

  it("puts the selected cone's scoops first among the children (#2272)", () => {
    const roster = [helper, research, worker, primary];
    // Selecting the primary cone, or one of its scoops, pulls `worker` forward.
    for (const selected of ['cone_1', 'scoop_1']) {
      expect(orderForSwitcher(roster, selected).map((s) => s.jid)).toEqual([
        'cone_1',
        'cone_2',
        'scoop_1',
        'scoop_2',
      ]);
    }
    // Cones never move; an unknown selection keeps registry order.
    expect(orderForSwitcher(roster, 'cone_2').map((s) => s.jid)).toEqual([
      'cone_1',
      'cone_2',
      'scoop_2',
      'scoop_1',
    ]);
    expect(orderForSwitcher(roster, 'nope').map((s) => s.jid)).toEqual(
      orderForSwitcher(roster).map((s) => s.jid)
    );
  });

  describe('rootForSelection (#2272)', () => {
    const all = [worker, research, primary, helper];

    it('returns a selected root unchanged', () => {
      expect(rootForSelection(all, research)?.jid).toBe('cone_2');
      expect(rootForSelection(all, primary)?.jid).toBe('cone_1');
    });

    it('walks a selected child up to the root that owns it', () => {
      expect(rootForSelection(all, worker)?.jid).toBe('cone_1');
      expect(rootForSelection(all, helper)?.jid).toBe('cone_2');
    });

    it('walks a grandchild up through its parent chain', () => {
      const grandchild = unit({ jid: 'scoop_3', parentJid: 'scoop_2', folder: 'deep' });
      expect(rootForSelection([...all, grandchild], grandchild)?.jid).toBe('cone_2');
    });

    it('falls back to the default root with nothing selected', () => {
      expect(rootForSelection(all, null)?.jid).toBe('cone_1');
      expect(rootForSelection(all, undefined)?.jid).toBe('cone_1');
    });

    it('falls back to the default root for a stale selection or an orphan', () => {
      expect(rootForSelection(all, { jid: 'gone', parentJid: null })?.jid).toBe('cone_1');
      const orphan = unit({ jid: 'scoop_9', parentJid: 'vanished', folder: 'orphan' });
      expect(rootForSelection([...all, orphan], orphan)?.jid).toBe('cone_1');
    });

    it('does not spin on a cyclic parent chain', () => {
      const a = unit({ jid: 'a', parentJid: 'b', folder: 'a' });
      const b = unit({ jid: 'b', parentJid: 'a', folder: 'b' });
      expect(rootForSelection([primary, a, b], a)?.jid).toBe('cone_1');
    });

    it('returns undefined when the roster has no root at all', () => {
      expect(rootForSelection([worker], worker)).toBeUndefined();
    });
  });

  describe('rootFolderForContext (#2272)', () => {
    it('maps cone contexts to their storage folder', () => {
      expect(rootFolderForContext(null)).toBe('cone');
      expect(rootFolderForContext(undefined)).toBe('cone');
      expect(rootFolderForContext('cone')).toBe('cone');
      expect(rootFolderForContext('cone:cone-research')).toBe('cone-research');
    });

    it('treats an empty cone folder as the primary one', () => {
      expect(rootFolderForContext('cone:')).toBe('cone');
    });

    it('returns null for non-cone contexts', () => {
      expect(rootFolderForContext('scoop:worker')).toBeNull();
      expect(rootFolderForContext('freezer:2026-01-01-x.md')).toBeNull();
    });
  });

  describe('rootForConeFolder (#2272)', () => {
    const all = [worker, research, primary, helper];

    it('resolves an archive folder back to its root', () => {
      expect(rootForConeFolder(all, 'cone-research')?.jid).toBe('cone_2');
      expect(rootForConeFolder(all, 'cone')?.jid).toBe('cone_1');
    });

    it('falls back to the default root for a legacy (missing) or removed folder', () => {
      expect(rootForConeFolder(all, undefined)?.jid).toBe('cone_1');
      expect(rootForConeFolder(all, 'cone-deleted')?.jid).toBe('cone_1');
    });

    it('never resolves a child folder as a root', () => {
      expect(rootForConeFolder(all, 'worker-scoop')?.jid).toBe('cone_1');
    });
  });
});
