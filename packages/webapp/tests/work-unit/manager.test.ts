import { describe, expect, it } from 'vitest';
import { buildWorkUnitRecord, WorkUnitManager } from '../../src/work-unit/manager.js';
import { interactiveRootPolicy } from '../../src/work-unit/policy.js';
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

  it('records detach-on-close only on a child that asked for it', () => {
    expect(
      buildWorkUnitRecord({ parentId: 'cone_1', name: 'keeper', onParentClose: 'detach' })
        .onParentClose
    ).toBe('detach');
    expect(
      buildWorkUnitRecord({ parentId: 'cone_1', name: 'plain' }).onParentClose
    ).toBeUndefined();
    // A root has no parent; the flag is ignored.
    expect(
      buildWorkUnitRecord({ parentId: null, name: 'Cone', onParentClose: 'detach' }).onParentClose
    ).toBeUndefined();
  });
});

describe('WorkUnitManager', () => {
  const root = rootRecord();
  const other = rootRecord({ jid: 'cone_2', addedAt: '2026-08-22T00:00:00.000Z' });
  const a = childRecord(root.jid, { folder: 'a' });
  const b = childRecord(root.jid, { folder: 'b' });
  const c = childRecord(other.jid, { folder: 'c' });

  function tree() {
    // Clone: promote/close mutate `parentJid` in place, and these records are
    // shared across the suite.
    const host = makeFakeHost([root, a, b, other, c].map((s) => ({ ...s })));
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

  it('create with config.workspaceMode private (no workspace wrapper) isolates the sandbox', async () => {
    const { host, manager } = tree();
    const d = await manager.create({
      parentId: root.jid,
      name: 'vault',
      config: { workspaceMode: 'private' },
    });
    expect(d.workspaceHandle.access).toBe('private');
    expect(d.policy.filesystem).toMatchObject({
      kind: 'restricted',
      mode: 'private',
      visiblePaths: [],
      writablePaths: ['/scoops/vault/'],
    });
    const recorded = host.registerScoop.mock.calls[0][0];
    expect(recorded.config?.workspaceMode).toBe('private');
    expect(recorded.config?.visiblePaths).not.toContain('/workspace/');
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


  describe('promote / detach (#2278)', () => {
    it('turns a child into an independent root and updates the descriptor', async () => {
      const { host, manager } = tree();
      const before = manager.get(a.jid)!.descriptor;
      expect(before.parentId).toBe(root.jid);
      expect(before.display.role).toBe('child');
      expect(before.policy.canCreateChildren).toBe(false);

      const d = await manager.promote(a.jid);
      expect(d.parentId).toBeNull();
      expect(d.display.role).toBe('primary');
      expect(d.policy).toEqual(interactiveRootPolicy());
      expect(d.completion).toEqual({ mode: 'interactive' });
      expect(d.onParentClose).toBe('cascade');
      // Folder (and therefore the chat session key) is kept; workspaceFor
      // then treats the unit as an extra cone.
      expect(d.folder).toBe(a.folder);
      expect(d.workspace.root).toBe(`/cones/${a.folder}/workspace`);
      expect(host.persistScoop).toHaveBeenCalledOnce();
      expect(host.persistScoop.mock.calls[0][0]).toMatchObject({
        jid: a.jid,
        parentJid: null,
        requiresTrigger: false,
      });
      expect(host.reinitLiveUnit).toHaveBeenCalledOnce();
      expect(host.reinitLiveUnit).toHaveBeenCalledWith(a.jid);
      expect(manager.getParent(a.jid)).toBeNull();
      expect(manager.roots().map((u) => u.descriptor.id)).toEqual([root.jid, a.jid, other.jid]);
      expect(manager.getChildren(root.jid).map((u) => u.descriptor.id)).toEqual([b.jid]);
      // The live runtime is the same object; its descriptor is a fresh projection.
      expect(manager.get(a.jid)!.descriptor.parentId).toBeNull();
    });

    it('rejects an unknown id', async () => {
      const { host, manager } = tree();
      await expect(manager.promote('ghost')).rejects.toThrow(/Work unit not found: ghost/);
      expect(host.persistScoop).not.toHaveBeenCalled();
      expect(host.reinitLiveUnit).not.toHaveBeenCalled();
    });

    it('is a no-op on a unit that is already a root', async () => {
      const { host, manager } = tree();
      const d = await manager.promote(root.jid);
      expect(d.parentId).toBeNull();
      expect(d.id).toBe(root.jid);
      expect(host.persistScoop).not.toHaveBeenCalled();
      expect(host.reinitLiveUnit).not.toHaveBeenCalled();
    });

    it('rolls the record back when persist fails', async () => {
      const { host, manager } = tree();
      host.persistScoop.mockRejectedValueOnce(new Error('disk full'));
      await expect(manager.promote(a.jid)).rejects.toThrow(/disk full/);
      expect(manager.get(a.jid)?.descriptor.parentId).toBe(root.jid);
      expect(manager.get(a.jid)?.descriptor.display.role).toBe('child');
      expect(host.getScoop(a.jid)?.trigger).toBe(`@${a.folder}`);
      expect(host.reinitLiveUnit).not.toHaveBeenCalled();
    });

    it('detach is an alias of promote', async () => {
      const { manager } = tree();
      const d = await manager.detach(b.jid);
      expect(d.parentId).toBeNull();
      expect(d.display.role).toBe('primary');
      expect(manager.get(b.jid)?.descriptor.parentId).toBeNull();
    });
  });

  describe('close descendants (#2278)', () => {
    it('cascades by default and still drops children', async () => {
      const { host, manager } = tree();
      await manager.close(root.jid);
      expect(host.unregisterScoop.mock.calls.map(([jid]) => jid)).toEqual([a.jid, b.jid, root.jid]);
      expect(manager.get(a.jid)).toBeNull();
      expect(manager.get(b.jid)).toBeNull();
      expect(manager.get(root.jid)).toBeNull();
      // The other root and its child are untouched.
      expect(manager.get(other.jid)?.descriptor.id).toBe(other.jid);
      expect(manager.get(c.jid)?.descriptor.parentId).toBe(other.jid);
    });

    it('detach-on-close leaves the configured child as a surviving root', async () => {
      const keeper = childRecord(root.jid, { folder: 'keeper', onParentClose: 'detach' });
      const dropped = childRecord(root.jid, { folder: 'dropped' });
      const host = makeFakeHost([root, keeper, dropped, other, c]);
      const manager = new WorkUnitManager(host);

      await manager.close(root.jid);
      expect(manager.get(root.jid)).toBeNull();
      expect(manager.get(dropped.jid)).toBeNull();
      const survivor = manager.get(keeper.jid);
      expect(survivor).not.toBeNull();
      expect(survivor!.descriptor.parentId).toBeNull();
      expect(survivor!.descriptor.display.role).toBe('primary');
      expect(survivor!.descriptor.policy).toEqual(interactiveRootPolicy());
      expect(manager.roots().map((u) => u.descriptor.id)).toEqual([keeper.jid, other.jid]);
    });

    it('close({ descendants: "detach" }) promotes every direct child', async () => {
      const { manager } = tree();
      await manager.close(root.jid, { descendants: 'detach' });
      expect(manager.get(root.jid)).toBeNull();
      expect(manager.get(a.jid)?.descriptor.parentId).toBeNull();
      expect(manager.get(b.jid)?.descriptor.parentId).toBeNull();
      expect(manager.get(c.jid)?.descriptor.parentId).toBe(other.jid);
    });

    it('an explicit cascade overrides a child that asked to detach', async () => {
      const keeper = childRecord(root.jid, { folder: 'keeper', onParentClose: 'detach' });
      const host = makeFakeHost([root, keeper]);
      const manager = new WorkUnitManager(host);
      await manager.close(root.jid, { descendants: 'cascade' });
      expect(manager.get(keeper.jid)).toBeNull();
      expect(manager.get(root.jid)).toBeNull();
    });

    it('a detached child keeps the grandchildren it already owned', async () => {
      const mid = childRecord(root.jid, { folder: 'mid', onParentClose: 'detach' });
      const deep = childRecord(mid.jid, { folder: 'deep' });
      const host = makeFakeHost([root, mid, deep, other]);
      const manager = new WorkUnitManager(host);
      await manager.close(root.jid);
      expect(manager.get(root.jid)).toBeNull();
      expect(manager.get(mid.jid)?.descriptor.parentId).toBeNull();
      expect(manager.get(deep.jid)?.descriptor.parentId).toBe(mid.jid);
      expect(manager.rootOf(deep.jid)?.descriptor.id).toBe(mid.jid);
    });
  });

});
