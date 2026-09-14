import { describe, expect, it, vi } from 'vitest';
import { GELATIERE_OWNER_JID } from '../../src/base/gelatiere-constants.js';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';
import {
  bootGelatiere,
  createGelatiereSeam,
  ensureGelatiereUnit,
  findGelatiereUnit,
  GELATIERE_BASE_ALLOWED_COMMANDS,
  GELATIERE_CHARTER,
  GELATIERE_SEAM_GLOBAL_KEY,
  GelatiereFolderTakenError,
  type GelatiereLickManager,
  type GelatiereOrchestrator,
  haltGelatiere,
  isGelatiereUnit,
  publishGelatiereSeam,
} from '../../src/scoops/gelatiere-unit.js';
import type { CronTaskEntry, LickEvent } from '../../src/scoops/lick-manager.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

function root(folder: string, extra: Partial<RegisteredScoop> = {}): RegisteredScoop {
  return {
    jid: `cone_${folder}`,
    name: folder,
    folder,
    requiresTrigger: false,
    assistantLabel: folder,
    addedAt: '2026-09-01T00:00:00.000Z',
    parentJid: null,
    ...extra,
  };
}

function fakeOrchestrator(initial: RegisteredScoop[]) {
  const scoops = [...initial];
  const orchestrator: GelatiereOrchestrator & { scoops: RegisteredScoop[] } = {
    scoops,
    getScoops: () => [...scoops],
    registerScoop: vi.fn(async (scoop: RegisteredScoop) => {
      scoops.push(scoop);
    }),
    unregisterScoop: vi.fn(async (jid: string) => {
      const index = scoops.findIndex((s) => s.jid === jid);
      if (index >= 0) scoops.splice(index, 1);
    }),
    persistScoop: vi.fn(async (scoop: RegisteredScoop) => {
      const index = scoops.findIndex((s) => s.jid === scoop.jid);
      if (index >= 0) scoops.splice(index, 1, scoop);
    }),
    reinitLiveUnit: vi.fn(async () => {}),
    getScoopTabState: vi.fn(() => tab),
  };
  let tab: { status: 'initializing' | 'ready' | 'processing' | 'error' } | undefined;
  return Object.assign(orchestrator, {
    setStatus(status: 'ready' | 'processing') {
      tab = { status };
    },
  });
}

function fakeLickManager(tasks: CronTaskEntry[] = []) {
  const events: LickEvent[] = [];
  let minted = 0;
  const lm: GelatiereLickManager & { events: LickEvent[] } = {
    events,
    emitEvent: (event) => {
      events.push(event);
    },
    createCronTask: vi.fn(async (name: string, cron: string, scoop?: string) => {
      const entry: CronTaskEntry = {
        id: `ct-${++minted}`,
        name,
        cron,
        scoop,
        nextRun: null,
        lastRun: null,
        status: 'active',
        createdAt: 'now',
      };
      tasks.push(entry);
      return entry;
    }),
    deleteCronTask: vi.fn(async (id: string) => {
      const index = tasks.findIndex((t) => t.id === id);
      if (index < 0) return false;
      tasks.splice(index, 1);
      return true;
    }),
    listCronTasks: () => [...tasks],
  };
  return lm;
}

describe('gelatiere unit', () => {
  it('isGelatiereUnit / findGelatiereUnit match only the child under the synthetic owner', () => {
    const scoops = [
      root('cone'),
      root('gelatiere'),
      { ...root('gelatiere'), jid: 'scoop_g', parentJid: 'cone_cone' },
      { ...root('gelatiere'), jid: 'scoop_gel', parentJid: GELATIERE_OWNER_JID },
    ];
    expect(isGelatiereUnit(scoops[3])).toBe(true);
    // A root that happens to use the folder, or a cone's own scoop of that
    // name, is not the gelatiere.
    expect(isGelatiereUnit(scoops[1])).toBe(false);
    expect(isGelatiereUnit(scoops[2])).toBe(false);
    expect(findGelatiereUnit(scoops)?.jid).toBe('scoop_gel');
  });

  it('ensureGelatiereUnit registers a silent, sandboxed child under the synthetic owner, once', async () => {
    const orchestrator = fakeOrchestrator([
      root('cone', { model: { provider: 'bedrock-camp', id: 'm' } }),
    ]);
    const first = await ensureGelatiereUnit(orchestrator);
    expect(first.created).toBe(true);
    expect(first.folder).toBe('gelatiere');
    const record = orchestrator.scoops.find((s) => s.folder === 'gelatiere');
    expect(record).toMatchObject({
      parentJid: GELATIERE_OWNER_JID,
      name: 'gelatiere',
      assistantLabel: 'gelatiere',
      notifyOnComplete: false,
      model: { provider: 'bedrock-camp', id: 'm' },
    });
    expect(record?.jid).toMatch(/^scoop_gelatiere_/);
    expect(record?.config).toMatchObject({
      systemPromptAppend: GELATIERE_CHARTER,
      visiblePaths: ['/sessions/', '/shared/', '/workspace/', '/home/', '/cones/'],
      writablePaths: ['/shared/.gelatiere/'],
      allowedCommands: GELATIERE_BASE_ALLOWED_COMMANDS,
    });
    for (const cmd of [
      'cat',
      'jq',
      'upskill',
      'sed',
      'awk',
      'grep',
      'gelatiere',
      'date',
      // The nightly's `memory dream --all` — the recipe in GELATIERE.md
      // must never escalate through the sudo gate on an unattended pass.
      'memory',
    ]) {
      expect(GELATIERE_BASE_ALLOWED_COMMANDS).toContain(cmd);
    }
    // `allowedCommands` is a child unit's only network gate, and this unit
    // reads third-party content on every unattended pass while seeing
    // /sessions/ — general egress would be an exfiltration channel. Its web
    // surface is `gelatiere catalog|commands|man` (pinned host) only.
    for (const cmd of ['curl', 'wget', 'fetch', 'nc', 'ssh']) {
      expect(GELATIERE_BASE_ALLOWED_COMMANDS).not.toContain(cmd);
    }
    expect(GELATIERE_CHARTER).toContain('cat /shared/GELATIERE.md');
    expect(GELATIERE_CHARTER).toContain('gelatiere deliver');
    const second = await ensureGelatiereUnit(orchestrator);
    expect(second).toEqual({
      folder: 'gelatiere',
      jid: first.jid,
      created: false,
      allowList: 'unchanged',
    });
    expect(orchestrator.registerScoop).toHaveBeenCalledTimes(1);
  });

  it("applies GELATIERE.md's allow-list at creation and to an existing unit", async () => {
    const orchestrator = fakeOrchestrator([root('cone')]);
    const merged = [...GELATIERE_BASE_ALLOWED_COMMANDS, 'tree'];
    const created = await ensureGelatiereUnit(orchestrator, merged);
    expect(created.created).toBe(true);
    const record = () => orchestrator.scoops.find((s) => s.folder === 'gelatiere');
    expect(record()?.config?.allowedCommands).toEqual(merged);

    // The same list again is not a change: no write, no runtime rebuild.
    const unchanged = await ensureGelatiereUnit(orchestrator, [...merged]);
    expect(unchanged.allowList).toBe('unchanged');
    expect(orchestrator.persistScoop).not.toHaveBeenCalled();

    // A changed list reaches the PERSISTED unit — it is registered once and
    // then lives for weeks, so an edit must not need `init --reset`.
    const widened = [...merged, 'xxd'];
    const updated = await ensureGelatiereUnit(orchestrator, widened);
    expect(updated).toEqual({
      folder: 'gelatiere',
      jid: created.jid,
      created: false,
      allowList: 'updated',
    });
    expect(record()?.config?.allowedCommands).toEqual(widened);
    // The shell reads its allow-list off the descriptor built with the
    // context, so the live unit has to be rebuilt for the change to bite.
    expect(orchestrator.reinitLiveUnit).toHaveBeenCalledWith(created.jid);
    // Other config the record carries survives the update.
    expect(record()?.config?.writablePaths).toEqual(['/shared/.gelatiere/']);
    expect(record()?.config?.systemPromptAppend).toBe(GELATIERE_CHARTER);

    // A caller without the file at hand (`gelatiere run`) leaves it alone
    // rather than resetting the unit to the base set.
    const untouched = await ensureGelatiereUnit(orchestrator);
    expect(untouched.allowList).toBe('unchanged');
    expect(record()?.config?.allowedCommands).toEqual(widened);
  });

  it('defers the allow-list while a pass is in flight — a rebuild would cancel it', async () => {
    resetLoggerDedupForTests();
    const orchestrator = fakeOrchestrator([root('cone')]);
    const created = await ensureGelatiereUnit(orchestrator, [...GELATIERE_BASE_ALLOWED_COMMANDS]);
    const record = () => orchestrator.scoops.find((s) => s.jid === created.jid);
    orchestrator.setStatus('processing');

    // `reinitLiveUnit` disposes the live context, which aborts the turn and
    // drops its queued licks. Record and context move together or not at all,
    // so neither is touched while the unit is mid-pass.
    const deferred = await ensureGelatiereUnit(orchestrator, [
      ...GELATIERE_BASE_ALLOWED_COMMANDS,
      'tree',
    ]);
    expect(deferred.allowList).toBe('deferred');
    expect(orchestrator.persistScoop).not.toHaveBeenCalled();
    expect(orchestrator.reinitLiveUnit).not.toHaveBeenCalled();
    expect(record()?.config?.allowedCommands).not.toContain('tree');

    // Idle again, the same call applies it.
    orchestrator.setStatus('ready');
    const applied = await ensureGelatiereUnit(orchestrator, [
      ...GELATIERE_BASE_ALLOWED_COMMANDS,
      'tree',
    ]);
    expect(applied.allowList).toBe('updated');
    expect(record()?.config?.allowedCommands).toContain('tree');
  });

  it('puts the old record back when the store write fails, so a retry still syncs', async () => {
    resetLoggerDedupForTests();
    const orchestrator = fakeOrchestrator([root('cone')]);
    const base = [...GELATIERE_BASE_ALLOWED_COMMANDS];
    const created = await ensureGelatiereUnit(orchestrator, base);
    const record = () => orchestrator.scoops.find((s) => s.jid === created.jid);
    const persist = vi.mocked(orchestrator.persistScoop);
    const saved = persist.getMockImplementation();
    // `Orchestrator.persistScoop` swaps its in-memory record BEFORE awaiting
    // the store write, so a rejected write must not leave the cache ahead of
    // both the store and the live context.
    persist.mockImplementationOnce(async (scoop: RegisteredScoop) => {
      await saved?.(scoop);
      throw new Error('IndexedDB is gone');
    });
    await expect(ensureGelatiereUnit(orchestrator, [...base, 'tree'])).rejects.toThrow(
      'IndexedDB is gone'
    );
    expect(record()?.config?.allowedCommands).toEqual(base);
    expect(orchestrator.reinitLiveUnit).not.toHaveBeenCalled();

    // The retry sees a record that still holds the old list, so it syncs for
    // real instead of reporting a change it never made.
    const retried = await ensureGelatiereUnit(orchestrator, [...base, 'tree']);
    expect(retried.allowList).toBe('updated');
    expect(record()?.config?.allowedCommands).toContain('tree');
    expect(orchestrator.reinitLiveUnit).toHaveBeenCalledWith(created.jid);
  });

  it('refuses to register while a foreign unit holds the folder, and --reset drops only its own', async () => {
    const orchestrator = fakeOrchestrator([root('cone'), root('gelatiere')]);
    await expect(ensureGelatiereUnit(orchestrator)).rejects.toBeInstanceOf(
      GelatiereFolderTakenError
    );
    await expect(ensureGelatiereUnit(orchestrator)).rejects.toThrow('held by cone cone_gelatiere');
    expect(orchestrator.registerScoop).not.toHaveBeenCalled();

    const lm = fakeLickManager();
    const seam = createGelatiereSeam(
      fakeOrchestrator([
        root('cone'),
        { ...root('gelatiere-2'), jid: 'scoop_gelatiere_2', parentJid: GELATIERE_OWNER_JID },
        { ...root('x'), jid: 'scoop_x', parentJid: 'cone_cone' },
      ]),
      lm
    );
    await seam.ensureNightly('0 3 * * *');
    expect(await seam.unregisterOwned()).toEqual(['scoop_gelatiere_2']);
    // The nightly went first (a unit with a live crontask cannot be dropped).
    expect(lm.deleteCronTask).toHaveBeenCalledWith('ct-1');
    expect(seam.nightly()).toBeUndefined();
    expect(await seam.unregisterOwned()).toEqual([]);
    const created = await seam.ensureUnit();
    expect(created.created).toBe(true);
    expect(created.folder).toBe('gelatiere');
  });

  it('the seam lists every root, licks by target, and registers the nightly once', async () => {
    const orchestrator = fakeOrchestrator([
      root('cone'),
      root('cone-research'),
      { ...root('gelatiere'), jid: 'scoop_gelatiere_1', parentJid: GELATIERE_OWNER_JID },
    ]);
    const lm = fakeLickManager();
    const seam = createGelatiereSeam(orchestrator, lm);
    expect(seam.unit()?.folder).toBe('gelatiere');
    expect(seam.roots().map((r) => r.folder)).toEqual(['cone', 'cone-research']);

    seam.lick('cone-research', { action: 'gelatiere-suggestions' });
    expect(lm.events[0]).toMatchObject({
      type: 'sprinkle',
      sprinkleName: 'gelatiere',
      targetScoop: 'cone-research',
      body: { action: 'gelatiere-suggestions' },
    });

    expect(seam.nightly()).toBeUndefined();
    const first = await seam.ensureNightly('0 3 * * *');
    expect(first).toEqual({ id: 'ct-1', cron: '0 3 * * *', created: true });
    expect(seam.nightly()).toEqual({ id: 'ct-1', cron: '0 3 * * *' });
    expect(lm.createCronTask).toHaveBeenCalledWith('gelatiere-nightly', '0 3 * * *', 'gelatiere');
    const same = await seam.ensureNightly('0 3 * * *');
    expect(same).toEqual({ id: 'ct-1', cron: '0 3 * * *', created: false });
    expect(lm.createCronTask).toHaveBeenCalledTimes(1);
    // A changed expression replaces the entry — editing GELATIERE.md then
    // `gelatiere init` must take effect.
    const changed = await seam.ensureNightly('0 4 * * *');
    expect(changed).toEqual({ id: 'ct-2', cron: '0 4 * * *', created: true });
    expect(lm.deleteCronTask).toHaveBeenCalledWith('ct-1');
    expect(seam.nightly()).toEqual({ id: 'ct-2', cron: '0 4 * * *' });
  });

  it('dropNightly removes the persisted nightly; haltGelatiere runs it on the flag-off path', async () => {
    resetLoggerDedupForTests();
    const lm = fakeLickManager();
    const seam = createGelatiereSeam(fakeOrchestrator([root('cone')]), lm);
    // Nothing scheduled yet — dropping is a no-op, not an error.
    expect(await seam.dropNightly()).toBe(false);
    await seam.ensureNightly('0 3 * * *');
    expect(seam.nightly()).toBeDefined();
    // The flag-off boot path: a nightly persisted while memory-v2 was on
    // must not keep waking the unit for billable passes.
    await haltGelatiere(seam);
    expect(seam.nightly()).toBeUndefined();
    // And a broken seam never breaks boot.
    const broken = {
      ...seam,
      dropNightly: async () => {
        throw new Error('storage gone');
      },
    };
    await expect(haltGelatiere(broken)).resolves.toBeUndefined();
  });

  it('publishGelatiereSeam publishes on the given target; bootGelatiere never throws', async () => {
    resetLoggerDedupForTests();
    const target: Record<string, unknown> = {};
    const orchestrator = fakeOrchestrator([root('cone')]);
    const seam = createGelatiereSeam(orchestrator, fakeLickManager());
    publishGelatiereSeam(seam, target);
    expect(target[GELATIERE_SEAM_GLOBAL_KEY]).toBe(seam);
    expect(GELATIERE_SEAM_GLOBAL_KEY).toBe('__slicc_gelatiere');

    await bootGelatiere(seam, '0 3 * * *', [...GELATIERE_BASE_ALLOWED_COMMANDS, 'tree']);
    expect(seam.unit()).toBeDefined();
    const booted = orchestrator.scoops.find((s) => s.folder === 'gelatiere');
    expect(booted?.config?.allowedCommands).toContain('tree');
    // And the seam reports the list in force off that record.
    expect(seam.unitAllowedCommands()).toContain('tree');
    const broken = {
      ...seam,
      ensureUnit: async () => {
        throw new Error('no fs');
      },
    };
    await expect(bootGelatiere(broken, '0 3 * * *')).resolves.toBeUndefined();
  });
});
