/**
 * The gelatiere — SLICC's resident advisor — as a work unit.
 *
 * It is a persistent SCOOP (folder `gelatiere`) that no cone owns: its
 * `parentJid` is the synthetic {@link GELATIERE_OWNER_JID}, so it is a child in
 * every way that matters to the user — read-only transcript, no composer, no
 * "New chat" — while no cone can feed, drop or cascade it. It keeps its own
 * conversation and is compacted on idle regardless of the flag, so it can run
 * for weeks without overrunning its own context. It never talks to the user;
 * it answers licks: the nightly crontask addressed to it, the session-end lick
 * the page sends, or a `gelatiere run`.
 * Each pass follows `/shared/GELATIERE.md` and ends in `gelatiere suggest`
 * (fold the candidates into the store) and `gelatiere deliver` (lick every
 * other root cone). Talking TO the cones is that delivery; nothing else.
 *
 * This module is the seam the kernel host publishes for the `gelatiere`
 * shell command (`globalThis.__slicc_gelatiere`): the command lives in
 * `shell/`, which may not import `scoops/`, so the orchestrator-facing
 * operations are handed down as a small object, like `__slicc_agent`.
 */

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

/**
 * The unit's standing instructions — what it IS, ahead of what any single
 * pass asks. Deliberately short: this rides every turn's system prompt; the
 * pass recipe itself lives in `/shared/GELATIERE.md`, read per pass and
 * summarised away by compaction afterwards.
 */
export const GELATIERE_CHARTER = [
  'You are the gelatiere: the resident advisor of this SLICC installation, a persistent scoop no cone owns. The user cannot message you directly and you never message them.',
  'You act only when a lick arrives — a `[Cron Event: gelatiere-nightly]`, a `[Sprinkle Event: gelatiere]` (a session ended, or someone ran `gelatiere run`), or a direct message asking for a pass.',
  'On every such lick: `cat /shared/GELATIERE.md` and follow it exactly. It ends with `gelatiere suggest <file>` and `gelatiere deliver`; those two commands are how your work reaches the cones. Do not install skills, do not edit memory files, do not message cones any other way.',
  'Reply in one short line per pass (what you looked at, how many suggestions landed). Your own history is compacted while you idle; keep durable notes in /shared/.gelatiere/notes.md, not in your replies.',
].join(' ');

/** A root cone the gelatiere can address, as the `gelatiere` command sees it. */
export interface GelatiereRoot {
  folder: string;
  name: string;
  jid: string;
}

/** What `gelatiere init` gets back. */
export interface GelatiereUnitInfo {
  folder: string;
  jid: string;
  created: boolean;
}

/** Thrown by {@link ensureGelatiereUnit} when another unit holds the folder. */
export class GelatiereFolderTakenError extends Error {
  constructor(readonly holder: RegisteredScoop) {
    super(
      `folder "${GELATIERE_FOLDER}" is held by ${holder.parentJid === null ? 'cone' : 'scoop'} ${holder.jid} — drop it, then run \`gelatiere init\``
    );
    this.name = 'GelatiereFolderTakenError';
  }
}

/** What the kernel host hands the `gelatiere` shell command. */
export interface GelatiereSeam {
  /** Create the unit if it is missing; idempotent. Throws {@link GelatiereFolderTakenError}. */
  ensureUnit(): Promise<GelatiereUnitInfo>;
  /**
   * Unregister every unit under the synthetic owner — the gelatiere itself
   * and any mis-foldered twin an earlier boot minted. Returns their jids.
   */
  unregisterOwned(): Promise<string[]>;
  /** The unit, when it exists. */
  unit(): GelatiereRoot | undefined;
  /** Every root cone — the delivery targets (the gelatiere is a child, never among them). */
  roots(): GelatiereRoot[];
  /**
   * Register the nightly crontask against the unit; idempotent by name. An
   * existing entry with a DIFFERENT expression is replaced, so editing
   * `nightly` in `GELATIERE.md` and running `gelatiere init` takes effect.
   */
  ensureNightly(cron: string): Promise<{ id: string; cron: string; created: boolean }>;
  /** The registered nightly crontask, when there is one. */
  nightly(): { id: string; cron: string } | undefined;
  /** Delete the nightly crontask when there is one. Returns whether one was removed. */
  dropNightly(): Promise<boolean>;
  /** Send a `gelatiere` sprinkle lick to one unit (a folder, name or jid alias). */
  lick(target: string, body: unknown): void;
}

/** The orchestrator surface the seam needs. */
export interface GelatiereOrchestrator {
  getScoops(): RegisteredScoop[];
  registerScoop(scoop: RegisteredScoop): Promise<void>;
  unregisterScoop(jid: string): Promise<void>;
}

/** The lick-manager surface the seam needs. */
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

/**
 * Commands a pass may run without escalating. A child unit runs under
 * `require-approval`, so every command missing here becomes a sudo request to
 * the default root — an interruption the user cannot grant away for an
 * unattended nightly pass. Keep this ahead of what `GELATIERE.md` asks for.
 */
export const GELATIERE_ALLOWED_COMMANDS = [
  'awk',
  'basename',
  'cat',
  'column',
  'curl',
  'cut',
  'date',
  'dirname',
  'echo',
  'expr',
  'false',
  'file',
  'find',
  // The first live pass reflowed long output with `fold -w 120` and the
  // escalation went to the default cone as a command lick.
  'fold',
  'gelatiere',
  'grep',
  'head',
  'jq',
  'ls',
  'man',
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

/** Read-only roots of a pass: sessions, shared, every cone's workspace and memory, the profiles. */
export const GELATIERE_VISIBLE_PATHS = [
  '/sessions/',
  '/shared/',
  '/workspace/',
  '/home/',
  '/cones/',
];
/** The one write grant beyond the sandbox and `/tmp/`: its own store and notes. */
export const GELATIERE_WRITABLE_PATHS = ['/shared/.gelatiere/'];

/**
 * Register the gelatiere scoop when it is missing. It starts on the default
 * root's model — the same fallback `cone-create` uses — so it never needs a
 * model of its own configured. Silent (`notifyOnComplete: false`): its passes
 * announce themselves through `gelatiere deliver`, and a completion or idle
 * notice on top would land in the default root's chat after every pass.
 */
export async function ensureGelatiereUnit(
  orchestrator: GelatiereOrchestrator
): Promise<GelatiereUnitInfo> {
  const existing = orchestrator.getScoops();
  const found = findGelatiereUnit(existing);
  if (found) return { folder: found.folder, jid: found.jid, created: false };
  // The folder is the lick address, so a foreign unit sitting on it would
  // make registration land on `gelatiere-2` — a unit nothing ever licks —
  // and every later boot would mint another. Refuse instead.
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
      // A unit with a live crontask refuses to unregister, and the nightly
      // resolves to whichever unit answers to the gelatiere name — so the
      // crontasks go first; `ensureNightly` puts the schedule back afterwards.
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

/** Publish the seam on `globalThis` (or `target`, for tests). */
export function publishGelatiereSeam(seam: GelatiereSeam, target: object = globalThis): void {
  (target as GelatiereGlobals)[GELATIERE_SEAM_GLOBAL_KEY] = seam;
}

/**
 * Boot-time hook: with the `memory-v2` flag on, make sure the unit and its
 * nightly crontask exist. Best-effort — a failure here logs and leaves the
 * manual `gelatiere init` path.
 */
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

/**
 * Boot-time hook for the flag-OFF path. A nightly crontask persisted while
 * Memory v2 was on would keep waking the unit for billable passes after the
 * user turned the flag off — LickManager reloads persisted crontasks on
 * every init. The unit itself stays (it is a frozen transcript without
 * licks); `bootGelatiere` puts the schedule back when the flag returns.
 */
export async function haltGelatiere(seam: GelatiereSeam): Promise<void> {
  try {
    if (await seam.dropNightly()) log.info('gelatiere nightly removed (memory-v2 is off)');
  } catch (error) {
    log.warn('gelatiere halt failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
