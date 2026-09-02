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

    // Grandchild paths must sit under the supervisor's sandbox (#2784
    // containment); mode defaults alone would name `/scoops/deep/`.
    const grandchild = await manager.create({
      parentId: lead.id,
      name: 'deep',
      config: {
        visiblePaths: ['/scoops/lead/'],
        writablePaths: ['/scoops/lead/deep/'],
      },
    });
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
    // Empty paths keep ⊆ so the refusal is the grant, not path escape.
    await expect(
      manager.create({
        parentId: helper.id,
        name: 'deep',
        config: { visiblePaths: [], writablePaths: [] },
      })
    ).rejects.toThrow(/cannot create children/);
    expect(host.registerScoop).toHaveBeenCalledOnce();
  });

  it('create refuses a nested-delegation grant the parent does not hold', async () => {
    const { host, manager } = tree();
    const helper = await manager.create({ parentId: root.jid, name: 'helper' });
    await expect(
      manager.create({
        parentId: helper.id,
        name: 'lead',
        config: {
          canCreateChildren: true,
          visiblePaths: [],
          writablePaths: [],
        },
      })
    ).rejects.toThrow(/isPolicySubset/);
    expect(host.registerScoop).toHaveBeenCalledOnce();
  });

  it('create rejects an explicit id that is already in the registry', async () => {
    const { host, manager } = tree();
    const before = manager.get(root.jid)?.descriptor.name;
    await expect(
      manager.create({ parentId: null, name: 'Impostor', folder: 'impostor', id: root.jid })
    ).rejects.toThrow(/Work unit already exists: cone_1/);
    expect(host.registerScoop).not.toHaveBeenCalled();
    expect(manager.get(root.jid)?.descriptor.name).toBe(before);
  });

  it("create names shared-readonly by default and preserves today's path lists", async () => {
    const { manager } = tree();
    const d = await manager.create({ parentId: root.jid, name: 'researcher' });
    expect(d.workspaceHandle.access).toBe('shared-readonly');
    expect(d.policy.filesystem).toMatchObject({
      kind: 'restricted',
      mode: 'shared-readonly',
      visiblePaths: ['/workspace/'],
      writablePaths: ['/scoops/researcher/', '/shared/'],
    });
  });

  it('create with workspace.mode private isolates the sandbox', async () => {
    const { host, manager } = tree();
    const d = await manager.create({
      parentId: root.jid,
      name: 'secret',
      workspace: { mode: 'private' },
    });
    expect(d.workspaceHandle.access).toBe('private');
    expect(d.policy.filesystem).toMatchObject({
      kind: 'restricted',
      mode: 'private',
      visiblePaths: [],
      writablePaths: ['/scoops/secret/'],
    });
    const recorded = host.registerScoop.mock.calls[0][0];
    expect(recorded.config?.workspaceMode).toBe('private');
    expect(recorded.config?.writablePaths).not.toContain('/shared/');
  });

  it('create throws on unimplemented snapshot / shared-live modes', async () => {
    const { manager } = tree();
    await expect(
      manager.create({ parentId: root.jid, name: 'cow', workspace: { mode: 'snapshot' } })
    ).rejects.toThrow(/not implemented/);
    await expect(
      manager.create({ parentId: root.jid, name: 'live', workspace: { mode: 'shared-live' } })
    ).rejects.toThrow(/not implemented/);
    await expect(
      manager.create({ parentId: null, name: 'root-snap', workspace: { mode: 'snapshot' } })
    ).rejects.toThrow(/RFC open question 4/);
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

  it('createMany registers several roots and returns descriptors in caller order', async () => {
    const { manager } = tree();
    const created = await manager.createMany([
      { parentId: null, name: 'R1', folder: 'r1' },
      { parentId: null, name: 'R2', folder: 'r2' },
    ]);
    expect(created.map((d) => d.name)).toEqual(['R1', 'R2']);
    expect(created.every((d) => d.parentId === null)).toBe(true);
    expect(manager.roots()).toHaveLength(4);
  });

  it('createMany registers a child under an intra-batch parent listed after it', async () => {
    const { manager } = tree();
    const created = await manager.createMany([
      { parentId: 'batch-root', name: 'helper', folder: 'batch-helper' },
      { parentId: null, name: 'Batch', folder: 'batch', id: 'batch-root' },
    ]);
    expect(created.map((d) => [d.id, d.parentId])).toEqual([
      [created[0].id, 'batch-root'],
      ['batch-root', null],
    ]);
    expect(manager.getParent(created[0].id)?.descriptor.id).toBe('batch-root');
  });

  it('createMany fails closed when any parent is missing — nothing is registered', async () => {
    const { host, manager } = tree();
    const before = manager.list().map((d) => d.id);
    await expect(
      manager.createMany([
        { parentId: null, name: 'ok', folder: 'ok' },
        { parentId: 'ghost', name: 'orphan' },
      ])
    ).rejects.toThrow(/Parent work unit not found: ghost/);
    expect(host.registerScoop).not.toHaveBeenCalled();
    expect(manager.list().map((d) => d.id)).toEqual(before);
  });

  it('createMany is all-or-nothing when registerScoop fails mid-batch', async () => {
    const { host, manager } = tree();
    const before = manager.list().map((d) => d.id);
    const original = host.registerScoop.getMockImplementation()!;
    let calls = 0;
    host.registerScoop.mockImplementation(async (scoop) => {
      calls += 1;
      if (calls === 2) throw new Error('register failed');
      return original(scoop);
    });

    await expect(
      manager.createMany([
        { parentId: null, name: 'KeepMe', folder: 'keep-me' },
        { parentId: null, name: 'DropMe', folder: 'drop-me' },
      ])
    ).rejects.toThrow(/register failed/);

    expect(manager.list().map((d) => d.id)).toEqual(before);
    expect(manager.list().some((d) => d.folder === 'keep-me')).toBe(false);
  });

  it('createMany rejects an explicit id already in the registry — nothing is registered', async () => {
    const { host, manager } = tree();
    const before = manager.list().map((d) => d.id);
    await expect(
      manager.createMany([
        { parentId: null, name: 'ok', folder: 'ok' },
        { parentId: null, name: 'Impostor', id: root.jid },
      ])
    ).rejects.toThrow(/Work unit already exists: cone_1/);
    expect(host.registerScoop).not.toHaveBeenCalled();
    expect(manager.list().map((d) => d.id)).toEqual(before);
  });

  it('createMany rejects a duplicate explicit id and a cycle without registering', async () => {
    const { host, manager } = tree();
    await expect(
      manager.createMany([
        { parentId: null, name: 'A', id: 'same' },
        { parentId: null, name: 'B', id: 'same' },
      ])
    ).rejects.toThrow(/Duplicate work unit id in createMany: same/);
    await expect(
      manager.createMany([
        { parentId: 'b', name: 'A', id: 'a' },
        { parentId: 'a', name: 'B', id: 'b' },
      ])
    ).rejects.toThrow(/createMany cycle/);
    expect(host.registerScoop).not.toHaveBeenCalled();
  });

  it('createMany rejects a duplicate folder within the batch — nothing is registered', async () => {
    const { host, manager } = tree();
    const before = manager.list().map((d) => d.id);
    await expect(
      manager.createMany([
        { parentId: null, name: 'A', folder: 'shared-folder' },
        { parentId: null, name: 'B', folder: 'shared-folder' },
      ])
    ).rejects.toThrow(/Duplicate work unit folder in createMany: shared-folder/);
    await expect(
      manager.createMany([
        { parentId: null, name: 'SameName' },
        { parentId: null, name: 'SameName' },
      ])
    ).rejects.toThrow(/Duplicate work unit folder in createMany: SameName/);
    expect(host.registerScoop).not.toHaveBeenCalled();
    expect(manager.list().map((d) => d.id)).toEqual(before);
  });

  it('createMany rejects a folder already in the registry — nothing is registered', async () => {
    const { host, manager } = tree();
    const before = manager.list().map((d) => d.id);
    await expect(
      manager.createMany([{ parentId: null, name: 'Impostor', folder: root.folder }])
    ).rejects.toThrow(/Duplicate work unit folder in createMany: cone/);
    expect(host.registerScoop).not.toHaveBeenCalled();
    expect(manager.list().map((d) => d.id)).toEqual(before);
  });

  it('join waits on children of two roots through the scoop-wait bus', async () => {
    const { host, manager } = tree();
    const pending = manager.join([a.jid, c.jid]);
    await host.complete(a.jid, 'from A');
    await host.complete(c.jid, 'from C');
    await expect(pending).resolves.toEqual([
      { id: a.jid, summary: 'from A', timedOut: false },
      { id: c.jid, summary: 'from C', timedOut: false },
    ]);
    expect(host.waitForScoops).toHaveBeenCalledWith([a.jid, c.jid], undefined);
  });

  it('join times out units that never settle', async () => {
    const { manager } = tree();
    const results = await manager.join([a.jid], { timeoutMs: 0 });
    expect(results).toEqual([{ id: a.jid, summary: null, timedOut: true }]);
  });

  it('join reports an unknown id as timedOut immediately', async () => {
    const { host, manager } = tree();
    const results = await manager.join(['ghost']);
    expect(results).toEqual([{ id: 'ghost', summary: null, timedOut: true }]);
    expect(host.waitForScoops).toHaveBeenCalledWith(['ghost'], undefined);
  });
});
