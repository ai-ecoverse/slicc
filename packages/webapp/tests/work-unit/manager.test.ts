import { describe, expect, it } from 'vitest';
import { buildWorkUnitRecord, WorkUnitManager } from '../../src/work-unit/manager.js';
import { childRecord, makeFakeHost, rootRecord } from './fixtures.js';

describe('buildWorkUnitRecord', () => {
  it('builds a root record shaped like bootstrapCone does today', () => {
    const record = buildWorkUnitRecord({ parentId: null, name: 'Cone', folder: 'cone' }, () => 42);
    expect(record).toEqual({
      jid: 'cone_42',
      name: 'Cone',
      folder: 'cone',
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: new Date(42).toISOString(),
      parentJid: null,
    });
  });

  it('builds a child record shaped like scoop_scoop does today', () => {
    const record = buildWorkUnitRecord(
      {
        parentId: 'cone_1',
        name: 'researcher',
        config: { visiblePaths: ['/workspace/'], writablePaths: ['/scoops/researcher/'] },
        notifyOnComplete: false,
      },
      () => 7
    );
    expect(record).toMatchObject({
      jid: 'scoop_researcher_7',
      folder: 'researcher',
      trigger: '@researcher',
      requiresTrigger: true,
      assistantLabel: 'researcher',
      parentJid: 'cone_1',
      notifyOnComplete: false,
    });
    expect(record.configSchemaVersion).toBeTypeOf('number');
  });

  it('honours a caller-supplied id', () => {
    expect(buildWorkUnitRecord({ parentId: null, name: 'x', id: 'custom' }).jid).toBe('custom');
  });
});

describe('WorkUnitManager', () => {
  const root = rootRecord();
  const other = rootRecord({ jid: 'cone_2', addedAt: '2026-08-22T00:00:00.000Z' });
  const a = childRecord(root.jid, { folder: 'a' });
  const b = childRecord(root.jid, { folder: 'b' });
  const c = childRecord(other.jid, { folder: 'c' });

  function tree() {
    const host = makeFakeHost([root, a, b, other, c]);
    return { host, manager: new WorkUnitManager(host) };
  }

  it('lists every unit as a descriptor', () => {
    const { manager } = tree();
    expect(manager.list().map((d) => [d.id, d.parentId])).toEqual([
      [root.jid, null],
      [a.jid, root.jid],
      [b.jid, root.jid],
      [other.jid, null],
      [c.jid, other.jid],
    ]);
  });

  it('answers parent / children / roots from the explicit edge', () => {
    const { manager } = tree();
    expect(manager.getParent(a.jid)?.descriptor.id).toBe(root.jid);
    expect(manager.getParent(root.jid)).toBeNull();
    expect(manager.getParent('nope')).toBeNull();
    expect(manager.getChildren(root.jid).map((u) => u.descriptor.id)).toEqual([a.jid, b.jid]);
    expect(manager.getChildren(other.jid).map((u) => u.descriptor.id)).toEqual([c.jid]);
    expect(manager.getChildren(a.jid)).toEqual([]);
    expect(manager.roots().map((u) => u.descriptor.id)).toEqual([root.jid, other.jid]);
  });

  it('resolves the default root as the oldest root', () => {
    const { manager } = tree();
    expect(manager.resolveDefaultRoot()?.descriptor.id).toBe(root.jid);
    const empty = new WorkUnitManager(makeFakeHost([]));
    expect(empty.resolveDefaultRoot()).toBeNull();
  });

  it('walks rootOf up the chain and survives a cycle', () => {
    const { host, manager } = tree();
    expect(manager.rootOf(a.jid)?.descriptor.id).toBe(root.jid);
    expect(manager.rootOf(root.jid)?.descriptor.id).toBe(root.jid);
    expect(manager.rootOf('nope')).toBeNull();
    const x = childRecord('y', { folder: 'x', jid: 'x' });
    const y = childRecord('x', { folder: 'y', jid: 'y' });
    host.scoops.set('x', x);
    host.scoops.set('y', y);
    expect(manager.rootOf('x')).toBeNull();
  });

  it('returns a stable runtime per id and forgets it once the record is gone', () => {
    const { host, manager } = tree();
    const first = manager.get(a.jid);
    expect(manager.get(a.jid)).toBe(first);
    host.scoops.delete(a.jid);
    expect(manager.get(a.jid)).toBeNull();
  });

  it('create registers a root through the host and returns its descriptor', async () => {
    const { host, manager } = tree();
    const d = await manager.create({ parentId: null, name: 'Second', folder: 'second' });
    expect(host.registerScoop).toHaveBeenCalledOnce();
    expect(d.parentId).toBeNull();
    expect(d.display.role).toBe('primary');
    expect(d.status).toBe('ready');
    expect(manager.roots()).toHaveLength(3);
  });

  it('create registers a child under an existing parent and rejects an unknown one', async () => {
    const { host, manager } = tree();
    const d = await manager.create({ parentId: root.jid, name: 'helper' });
    expect(d.parentId).toBe(root.jid);
    expect(d.completion).toEqual({ mode: 'notify-parent' });
    expect(manager.getChildren(root.jid).map((u) => u.descriptor.id)).toContain(d.id);

    await expect(manager.create({ parentId: 'ghost', name: 'orphan' })).rejects.toThrow(
      /Parent work unit not found/
    );
    expect(host.registerScoop).toHaveBeenCalledOnce();
  });

  it('create grants nested delegation from config and records the ownership edge', async () => {
    const { manager } = tree();
    const lead = await manager.create({
      parentId: root.jid,
      name: 'lead',
      config: { canCreateChildren: true },
    });
    expect(lead.parentId).toBe(root.jid);
    expect(lead.display.role).toBe('child');
    expect(lead.policy.canCreateChildren).toBe(true);
    expect(lead.policy.canManageChildren).toBe(true);

    const grandchild = await manager.create({ parentId: lead.id, name: 'deep' });
    expect(grandchild.parentId).toBe(lead.id);
    expect(grandchild.policy.canCreateChildren).toBe(false);
    expect(grandchild.policy.canManageChildren).toBe(false);
    expect(manager.getParent(grandchild.id)?.descriptor.id).toBe(lead.id);
    expect(manager.getChildren(lead.id).map((u) => u.descriptor.id)).toEqual([grandchild.id]);
    expect(manager.rootOf(grandchild.id)?.descriptor.id).toBe(root.jid);
  });

  it('create refuses a grandchild when the parent was not granted canCreateChildren', async () => {
    const { host, manager } = tree();
    const helper = await manager.create({ parentId: root.jid, name: 'helper' });
    expect(helper.policy.canCreateChildren).toBe(false);
    await expect(manager.create({ parentId: helper.id, name: 'deep' })).rejects.toThrow(
      /cannot create children/
    );
    expect(host.registerScoop).toHaveBeenCalledOnce();
  });

  it('create refuses a nested-delegation grant the parent does not hold', async () => {
    const { host, manager } = tree();
    const helper = await manager.create({ parentId: root.jid, name: 'helper' });
    await expect(
      manager.create({
        parentId: helper.id,
        name: 'lead',
        config: { canCreateChildren: true },
      })
    ).rejects.toThrow(/isPolicySubset/);
    expect(host.registerScoop).toHaveBeenCalledOnce();
  });

  it('abort stops the turn; close unregisters and drops the runtime', async () => {
    const { host, manager } = tree();
    await manager.abort(a.jid);
    expect(host.stopScoop).toHaveBeenCalledWith(a.jid);
    await manager.abort('nope');
    expect(host.stopScoop).toHaveBeenCalledOnce();

    await manager.close(a.jid);
    expect(host.unregisterScoop).toHaveBeenCalledWith(a.jid);
    expect(manager.get(a.jid)).toBeNull();
    expect(manager.getChildren(root.jid).map((u) => u.descriptor.id)).toEqual([b.jid]);
    // the root is untouched
    expect(manager.get(root.jid)?.descriptor.status).toBe('creating');
    await manager.close('nope');
    expect(host.unregisterScoop).toHaveBeenCalledOnce();
  });
});
