import type { LickEvent } from '@slicc/shared-ts';
import {
  GELATIERE_FOLDER,
  GELATIERE_NIGHTLY_CRON_NAME,
  GELATIERE_OWNER_JID,
  GELATIERE_SPRINKLE_NAME,
  isGelatiereUnit,
} from '../base/gelatiere-constants.js';
import { createLogger } from '../base/logger.js';
import { buildWorkUnitRecord } from '../work-unit/manager.js';
import { rootsOf } from '../work-unit/policy.js';
import { modelFor } from '../work-unit/record.js';
import type { CronTaskEntry } from './lick-manager.js';
import type { RegisteredScoop } from './types.js';

const log = createLogger('gelatiere-unit');

export const GELATIERE_SEAM_GLOBAL_KEY = '__slicc_gelatiere';

export const GELATIERE_CHARTER = [
  'You are the gelatiere: the resident advisor of this SLICC installation, a persistent scoop no cone owns. The user cannot message you directly and you never message them.',
  'You act only when a lick arrives — a `[Cron Event: gelatiere-nightly]`, a `[Sprinkle Event: gelatiere]` (a session ended, or someone ran `gelatiere run`), or a direct message asking for a pass.',
  'On every such lick: `cat /shared/GELATIERE.md` and follow it exactly. It ends with `gelatiere suggest <file>` and `gelatiere deliver`; those two commands are how your work reaches the cones. Do not install skills, do not edit memory files, do not message cones any other way.',
  'Reply in one short line per pass (what you looked at, how many suggestions landed). Your own history is compacted while you idle; keep durable notes in /shared/.gelatiere/notes.md, not in your replies.',
].join(' ');

export interface GelatiereRoot {
  folder: string;
  name: string;
  jid: string;
}

export interface GelatiereUnitInfo {
  folder: string;
  jid: string;
  created: boolean;
}

export class GelatiereFolderTakenError extends Error {
  constructor(readonly holder: RegisteredScoop) {
    super(
      `folder "${GELATIERE_FOLDER}" is held by ${holder.parentJid === null ? 'cone' : 'scoop'} ${holder.jid} — drop it, then run \`gelatiere init\``
    );
    this.name = 'GelatiereFolderTakenError';
  }
}

export interface GelatiereSeam {
  ensureUnit(): Promise<GelatiereUnitInfo>;

  unregisterOwned(): Promise<string[]>;

  unit(): GelatiereRoot | undefined;

  roots(): GelatiereRoot[];

  ensureNightly(cron: string): Promise<{ id: string; cron: string; created: boolean }>;

  nightly(): { id: string; cron: string } | undefined;

  dropNightly(): Promise<boolean>;

  lick(target: string, body: unknown): void;
}

export interface GelatiereOrchestrator {
  getScoops(): RegisteredScoop[];
  registerScoop(scoop: RegisteredScoop): Promise<void>;
  unregisterScoop(jid: string): Promise<void>;
}

export interface GelatiereLickManager {
  emitEvent(event: LickEvent): void;
  createCronTask(name: string, cron: string, scoop?: string): Promise<CronTaskEntry>;
  deleteCronTask(id: string): Promise<boolean>;
  listCronTasks(): CronTaskEntry[];
}

export { isGelatiereUnit };

export function findGelatiereUnit(scoops: readonly RegisteredScoop[]): RegisteredScoop | undefined {
  return scoops.find(isGelatiereUnit);
}

function findNightly(lickManager: GelatiereLickManager): CronTaskEntry | undefined {
  return lickManager
    .listCronTasks()
    .find((t) => t.name === GELATIERE_NIGHTLY_CRON_NAME && t.scoop === GELATIERE_FOLDER);
}

function toRoot(scoop: RegisteredScoop): GelatiereRoot {
  return { folder: scoop.folder, name: scoop.name, jid: scoop.jid };
}

export const GELATIERE_ALLOWED_COMMANDS = [
  'awk',
  'basename',
  'cat',
  'column',

  'cut',
  'date',
  'dirname',
  'echo',
  'expr',
  'false',
  'file',
  'find',

  'fold',
  'gelatiere',
  'grep',
  'head',
  'jq',
  'ls',
  'man',

  'memory',
  'mkdir',
  'nl',
  'paste',
  'printf',
  'realpath',
  'rg',
  'sed',
  'seq',
  'sort',
  'stat',
  'tail',
  'tee',
  'test',
  'touch',
  'tr',
  'true',
  'uniq',
  'upskill',
  'wc',
];

export const GELATIERE_VISIBLE_PATHS = [
  '/sessions/',
  '/shared/',
  '/workspace/',
  '/home/',
  '/cones/',
];

export const GELATIERE_WRITABLE_PATHS = ['/shared/.gelatiere/'];

export async function ensureGelatiereUnit(
  orchestrator: GelatiereOrchestrator
): Promise<GelatiereUnitInfo> {
  const existing = orchestrator.getScoops();
  const found = findGelatiereUnit(existing);
  if (found) return { folder: found.folder, jid: found.jid, created: false };

  const holder = existing.find((s) => s.folder === GELATIERE_FOLDER);
  if (holder) throw new GelatiereFolderTakenError(holder);
  const defaultRoot = rootsOf(existing)[0];
  const inheritedModel = defaultRoot ? modelFor(defaultRoot) : undefined;
  const record: RegisteredScoop = {
    ...buildWorkUnitRecord({
      parentId: GELATIERE_OWNER_JID,
      name: GELATIERE_FOLDER,
      folder: GELATIERE_FOLDER,
      notifyOnComplete: false,
      config: {
        systemPromptAppend: GELATIERE_CHARTER,
        visiblePaths: [...GELATIERE_VISIBLE_PATHS],
        writablePaths: [...GELATIERE_WRITABLE_PATHS],
        allowedCommands: [...GELATIERE_ALLOWED_COMMANDS],
      },
    }),
    assistantLabel: GELATIERE_FOLDER,
    ...(inheritedModel ? { model: inheritedModel } : {}),
  };
  await orchestrator.registerScoop(record);
  log.info('gelatiere unit registered', { jid: record.jid });
  return { folder: record.folder, jid: record.jid, created: true };
}

export function createGelatiereSeam(
  orchestrator: GelatiereOrchestrator,
  lickManager: GelatiereLickManager
): GelatiereSeam {
  return {
    ensureUnit: () => ensureGelatiereUnit(orchestrator),
    unregisterOwned: async () => {
      for (const task of lickManager.listCronTasks()) {
        if (task.name === GELATIERE_NIGHTLY_CRON_NAME) await lickManager.deleteCronTask(task.id);
      }
      const owned = orchestrator.getScoops().filter((s) => s.parentJid === GELATIERE_OWNER_JID);
      for (const unit of owned) await orchestrator.unregisterScoop(unit.jid);
      return owned.map((s) => s.jid);
    },
    unit: () => {
      const found = findGelatiereUnit(orchestrator.getScoops());
      return found ? toRoot(found) : undefined;
    },
    roots: () => rootsOf(orchestrator.getScoops()).map(toRoot),
    nightly: () => {
      const found = findNightly(lickManager);
      return found ? { id: found.id, cron: found.cron } : undefined;
    },
    ensureNightly: async (cron) => {
      const existing = findNightly(lickManager);
      if (existing?.cron === cron) return { id: existing.id, cron: existing.cron, created: false };
      if (existing) await lickManager.deleteCronTask(existing.id);
      const entry = await lickManager.createCronTask(
        GELATIERE_NIGHTLY_CRON_NAME,
        cron,
        GELATIERE_FOLDER
      );
      return { id: entry.id, cron: entry.cron, created: true };
    },
    dropNightly: async () => {
      const existing = findNightly(lickManager);
      if (!existing) return false;
      return lickManager.deleteCronTask(existing.id);
    },
    lick: (target, body) => {
      lickManager.emitEvent({
        type: 'sprinkle',
        sprinkleName: GELATIERE_SPRINKLE_NAME,
        targetScoop: target,
        timestamp: new Date().toISOString(),
        body,
      });
    },
  };
}

interface GelatiereGlobals {
  [GELATIERE_SEAM_GLOBAL_KEY]?: GelatiereSeam;
}

export function publishGelatiereSeam(seam: GelatiereSeam, target: object = globalThis): void {
  (target as GelatiereGlobals)[GELATIERE_SEAM_GLOBAL_KEY] = seam;
}

export async function bootGelatiere(seam: GelatiereSeam, nightlyCron: string): Promise<void> {
  try {
    const unit = await seam.ensureUnit();
    const nightly = await seam.ensureNightly(nightlyCron);
    log.info('gelatiere ready', {
      jid: unit.jid,
      created: unit.created,
      nightly: nightly.cron,
      nightlyCreated: nightly.created,
    });
  } catch (error) {
    log.warn('gelatiere boot failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function haltGelatiere(seam: GelatiereSeam): Promise<void> {
  try {
    if (await seam.dropNightly()) log.info('gelatiere nightly removed (memory-v2 is off)');
  } catch (error) {
    log.warn('gelatiere halt failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
