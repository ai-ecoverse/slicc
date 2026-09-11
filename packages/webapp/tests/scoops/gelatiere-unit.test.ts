import { describe, expect, it, vi } from 'vitest';
import { GELATIERE_OWNER_JID } from '../../src/base/gelatiere-constants.js';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';
import {
  bootGelatiere,
  createGelatiereSeam,
  ensureGelatiereUnit,
  findGelatiereUnit,
  GELATIERE_ALLOWED_COMMANDS,
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
  };
  return orchestrator;
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
      allowedCommands: GELATIERE_ALLOWED_COMMANDS,
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
      expect(GELATIERE_ALLOWED_COMMANDS).toContain(cmd);
    }
    // `allowedCommands` is a child unit's only network gate, and this unit
    // reads third-party content on every unattended pass while seeing
    // /sessions/ — general egress would be an exfiltration channel. Its web
    // surface is `gelatiere catalog|commands|man` (pinned host) only.
    for (const cmd of ['curl', 'wget', 'fetch', 'nc', 'ssh']) {
      expect(GELATIERE_ALLOWED_COMMANDS).not.toContain(cmd);
    }
    expect(GELATIERE_CHARTER).toContain('cat /shared/GELATIERE.md');
    expect(GELATIERE_CHARTER).toContain('gelatiere deliver');
    const second = await ensureGelatiereUnit(orchestrator);
    expect(second).toEqual({ folder: 'gelatiere', jid: first.jid, created: false });
    expect(orchestrator.registerScoop).toHaveBeenCalledTimes(1);
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
    const seam = createGelatiereSeam(fakeOrchestrator([root('cone')]), fakeLickManager());
    publishGelatiereSeam(seam, target);
    expect(target[GELATIERE_SEAM_GLOBAL_KEY]).toBe(seam);
    expect(GELATIERE_SEAM_GLOBAL_KEY).toBe('__slicc_gelatiere');

    await bootGelatiere(seam, '0 3 * * *');
    expect(seam.unit()).toBeDefined();
    const broken = {
      ...seam,
      ensureUnit: async () => {
        throw new Error('no fs');
      },
    };
    await expect(bootGelatiere(broken, '0 3 * * *')).resolves.toBeUndefined();
  });
});
