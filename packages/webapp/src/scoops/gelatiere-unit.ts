import type { LickEvent } from '@slicc/shared-ts';
import {
  GELATIERE_FOLDER,
  GELATIERE_NIGHTLY_CRON_NAME,
  GELATIERE_OWNER_JID,
  GELATIERE_SPRINKLE_NAME,
  isGelatiereUnit,
} from '../base/gelatiere-constants.js';
import { GELATIERE_BASE_ALLOWED_COMMANDS } from '../base/gelatiere-store.js';
import { createLogger } from '../base/logger.js';
import { buildWorkUnitRecord } from '../work-unit/manager.js';
import { rootsOf } from '../work-unit/policy.js';
import { leadingRootOf, modelFor } from '../work-unit/record.js';
import type { CronTaskEntry } from './lick-manager.js';
import type { RegisteredScoop, ScoopTabState } from './types.js';

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

export type GelatiereAllowListOutcome = 'unchanged' | 'updated' | 'deferred';

export interface GelatiereUnitInfo {
  folder: string;
  jid: string;
  created: boolean;

  allowList?: GelatiereAllowListOutcome;
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
  ensureUnit(allowedCommands?: readonly string[]): Promise<GelatiereUnitInfo>;

  unregisterOwned(): Promise<string[]>;

  unit(): GelatiereRoot | undefined;

  unitAllowedCommands(): readonly string[] | undefined;

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

  persistScoop(scoop: RegisteredScoop): Promise<void>;

  reinitLiveUnit(jid: string): Promise<void>;

  syncGelatiereModel(): Promise<boolean>;

  getScoopTabState(jid: string): { status: ScoopTabState['status'] } | undefined;
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

export { GELATIERE_BASE_ALLOWED_COMMANDS };

export const GELATIERE_VISIBLE_PATHS = [
  '/sessions/',
  '/shared/',
  '/workspace/',
  '/home/',
  '/cones/',
];

export const GELATIERE_WRITABLE_PATHS = ['/shared/.gelatiere/'];

async function syncAllowedCommands(
  orchestrator: GelatiereOrchestrator,
  unit: RegisteredScoop,
  allowedCommands: readonly string[] | undefined
): Promise<GelatiereAllowListOutcome> {
  if (!allowedCommands) return 'unchanged';
  const current = unit.config?.allowedCommands ?? [];
  if (sameCommands(current, allowedCommands)) return 'unchanged';

  if (orchestrator.getScoopTabState(unit.jid)?.status === 'processing') {
    log.info('gelatiere allow-list edit deferred: the unit is mid-pass', { jid: unit.jid });
    return 'deferred';
  }
  const record: RegisteredScoop = {
    ...unit,
    config: { ...unit.config, allowedCommands: [...allowedCommands] },
  };
  try {
    await orchestrator.persistScoop(record);
  } catch (error) {
    await orchestrator.persistScoop(unit).catch(() => {});
    throw error;
  }
  await orchestrator.reinitLiveUnit(record.jid);
  log.info('gelatiere allow-list updated from GELATIERE.md', {
    jid: record.jid,
    commands: allowedCommands.length,
  });
  return 'updated';
}

function sameCommands(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((command, index) => command === b[index]);
}

export async function ensureGelatiereUnit(
  orchestrator: GelatiereOrchestrator,
  allowedCommands?: readonly string[]
): Promise<GelatiereUnitInfo> {
  const existing = orchestrator.getScoops();
  const found = findGelatiereUnit(existing);
  if (found) {
    await orchestrator.syncGelatiereModel();
    const allowList = await syncAllowedCommands(orchestrator, found, allowedCommands);
    return { folder: found.folder, jid: found.jid, created: false, allowList };
  }

  const holder = existing.find((s) => s.folder === GELATIERE_FOLDER);
  if (holder) throw new GelatiereFolderTakenError(holder);
  const leadingRoot = leadingRootOf(existing);
  const inheritedModel = leadingRoot ? modelFor(leadingRoot) : undefined;
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
        allowedCommands: [...(allowedCommands ?? GELATIERE_BASE_ALLOWED_COMMANDS)],
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
    ensureUnit: (allowedCommands) => ensureGelatiereUnit(orchestrator, allowedCommands),
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
    unitAllowedCommands: () => findGelatiereUnit(orchestrator.getScoops())?.config?.allowedCommands,
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

export async function bootGelatiere(
  seam: GelatiereSeam,
  nightlyCron: string,
  allowedCommands?: readonly string[]
): Promise<void> {
  try {
    const unit = await seam.ensureUnit(allowedCommands);
    const nightly = await seam.ensureNightly(nightlyCron);
    log.info('gelatiere ready', {
      jid: unit.jid,
      created: unit.created,
      allowList: unit.allowList,
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
