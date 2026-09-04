import { describe, expect, it } from 'vitest';
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
import type { WorkUnitSummary } from '../../../src/work-unit/client/types.js';

/**
 * These helpers read the client protocol's SUMMARY since #2382 D2a, so the
 * fixtures are summaries: `id` / `parentId` / `role` rather than the record's
 * `jid` / `parentJid`.
 */
function unit(
  over: Partial<WorkUnitSummary> & { jid?: string; parentJid?: string | null }
): WorkUnitSummary {
  const parentId = 'parentJid' in over ? over.parentJid : (over.parentId ?? 'cone_1');
  return {
    assistantLabel: 'label',
    addedAt: '2026-01-01T00:00:00.000Z',
    fill: 0,
    folder: 'folder',
    id: over.jid ?? over.id ?? 'jid',
    name: 'Name',
    parentId: parentId ?? null,
    role: (parentId ?? null) === null ? 'primary' : 'child',
    state: 'idle',
    ...Object.fromEntries(
      Object.entries(over).filter(([key]) => key !== 'jid' && key !== 'parentJid')
    ),
  } as WorkUnitSummary;
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
    expect(unitForContext(all, 'cone')?.id).toBe('cone_1');
    expect(unitForContext(all, 'cone:cone-research')?.id).toBe('cone_2');
    expect(unitForContext(all, 'cone:nope')).toBeUndefined();
    expect(unitForContext(all, 'scoop:helper')?.id).toBe('scoop_2');
    expect(unitForContext(all, 'scoop:cone')).toBeUndefined();
    // an unknown plain context falls back to the default root
    expect(unitForContext(all, 'whatever')?.id).toBe('cone_1');
  });

  it('prefers the primary root, else the oldest root, as default', () => {
    expect(defaultRootOf([worker, research, primary])?.id).toBe('cone_1');
    expect(defaultRootOf([worker, research])?.id).toBe('cone_2');
    expect(defaultRootOf([worker])).toBeUndefined();
  });

  it('reads "oldest" as the STRIP does, not as roster order', () => {
    // The primary cone is gone (dropped), and the restore walked IndexedDB
    // key order, so the roster lists the NEWER extra cone first. Taking the
    // first root here would point boot selection, the sprinkle stop, the
    // freezer fallback and a bare `?ctx=cone` at a different cone than the
    // leftmost tab, which orders roots by `addedAt`.
    const older = unit({
      jid: 'cone_3',
      parentJid: null,
      folder: 'cone-older',
      addedAt: '2026-01-02T00:00:00.000Z',
    });
    const newer = unit({
      jid: 'cone_4',
      parentJid: null,
      folder: 'cone-newer',
      addedAt: '2026-01-09T00:00:00.000Z',
    });
    const roster = [newer, older, worker];
    expect(defaultRootOf(roster)?.id).toBe('cone_3');
    expect(orderForSwitcher(roster)[0]?.id).toBe('cone_3');
    expect(defaultRootOf(roster)?.id).toBe(orderForSwitcher(roster)[0]?.id);
  });

  it('keeps transport order when a root is missing addedAt, on both reads', () => {
    // All-or-nothing: sorting a half-timestamped roster would interleave a
    // real ordering with a positional one. The strip and the default
    // selection must at least agree on the answer they give.
    const undated = unit({ jid: 'cone_5', parentJid: null, folder: 'cone-undated' });
    delete (undated as { addedAt?: string }).addedAt;
    const dated = unit({
      jid: 'cone_6',
      parentJid: null,
      folder: 'cone-dated',
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    const roster = [undated, dated];
    expect(defaultRootOf(roster)?.id).toBe('cone_5');
    expect(defaultRootOf(roster)?.id).toBe(orderForSwitcher(roster)[0]?.id);
  });

  it('orders roots (oldest first) ahead of children, grouped by owner', () => {
    // With nothing selected the children follow their cones in cone order
    // (#2274): `scoop_1` belongs to the primary cone, `scoop_2` to the second.
    // Before the leader and the follower shared one ordering the leader kept
    // registry order here and the follower grouped by owner — the same roster
    // rendered two ways on two screens.
    expect(orderForSwitcher([helper, research, worker, primary]).map((s) => s.id)).toEqual([
      'cone_1',
      'cone_2',
      'scoop_1',
      'scoop_2',
    ]);
  });

  it("puts the selected cone's scoops first among the children (#2272)", () => {
    const roster = [helper, research, worker, primary];
    // Selecting the primary cone, or one of its scoops, pulls `worker` forward.
    for (const selected of ['cone_1', 'scoop_1']) {
      expect(orderForSwitcher(roster, selected).map((s) => s.id)).toEqual([
        'cone_1',
        'cone_2',
        'scoop_1',
        'scoop_2',
      ]);
    }
    // Cones never move; an unknown selection keeps registry order.
    expect(orderForSwitcher(roster, 'cone_2').map((s) => s.id)).toEqual([
      'cone_1',
      'cone_2',
      'scoop_2',
      'scoop_1',
    ]);
    expect(orderForSwitcher(roster, 'nope').map((s) => s.id)).toEqual(
      orderForSwitcher(roster).map((s) => s.id)
    );
  });

  describe('rootForSelection (#2272)', () => {
    const all = [worker, research, primary, helper];

    it('returns a selected root unchanged', () => {
      expect(rootForSelection(all, research)?.id).toBe('cone_2');
      expect(rootForSelection(all, primary)?.id).toBe('cone_1');
    });

    it('walks a selected child up to the root that owns it', () => {
      expect(rootForSelection(all, worker)?.id).toBe('cone_1');
      expect(rootForSelection(all, helper)?.id).toBe('cone_2');
    });

    it('walks a grandchild up through its parent chain', () => {
      const grandchild = unit({ jid: 'scoop_3', parentJid: 'scoop_2', folder: 'deep' });
      expect(rootForSelection([...all, grandchild], grandchild)?.id).toBe('cone_2');
    });

    it('falls back to the default root with nothing selected', () => {
      expect(rootForSelection(all, null)?.id).toBe('cone_1');
      expect(rootForSelection(all, undefined)?.id).toBe('cone_1');
    });

    it('falls back to the default root for a stale selection or an orphan', () => {
      expect(rootForSelection(all, { id: 'gone' })?.id).toBe('cone_1');
      const orphan = unit({ jid: 'scoop_9', parentJid: 'vanished', folder: 'orphan' });
      expect(rootForSelection([...all, orphan], orphan)?.id).toBe('cone_1');
    });

    it('does not spin on a cyclic parent chain', () => {
      const a = unit({ jid: 'a', parentJid: 'b', folder: 'a' });
      const b = unit({ jid: 'b', parentJid: 'a', folder: 'b' });
      expect(rootForSelection([primary, a, b], a)?.id).toBe('cone_1');
    });

    it('returns undefined when the roster has no root at all', () => {
      expect(rootForSelection([worker], worker)).toBeUndefined();
    });

    it('refuses to name an owner for a child whose edge was never sent (#2382 D2b)', () => {
      // `parentId` is optional on the protocol: a leader too old to send the
      // edge leaves it absent while `role` still says the unit is owned. The
      // default root is the WRONG answer — freeze, model and stop would bind
      // to a cone this scoop does not belong to.
      const edgeless = unit({ jid: 'scoop_8', folder: 'edgeless', role: 'child' });
      delete (edgeless as { parentId?: string | null }).parentId;
      expect(edgeless.parentId).toBeUndefined();
      expect(rootForSelection([...all, edgeless], edgeless)).toBeUndefined();
      // …and a unit the roster does not know at all still falls back, because
      // that is a render race and not an absent edge.
      expect(rootForSelection([...all, edgeless], { id: 'gone' })?.id).toBe('cone_1');
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
      expect(rootForConeFolder(all, 'cone-research')?.id).toBe('cone_2');
      expect(rootForConeFolder(all, 'cone')?.id).toBe('cone_1');
    });

    it('falls back to the default root for a legacy (missing) or removed folder', () => {
      expect(rootForConeFolder(all, undefined)?.id).toBe('cone_1');
      expect(rootForConeFolder(all, 'cone-deleted')?.id).toBe('cone_1');
    });

    it('never resolves a child folder as a root', () => {
      expect(rootForConeFolder(all, 'worker-scoop')?.id).toBe('cone_1');
    });
  });
});
