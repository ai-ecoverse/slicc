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
import { GELATIERE_BASE_ALLOWED_COMMANDS } from '../base/gelatiere-store.js';
import { createLogger } from '../base/logger.js';
import { buildWorkUnitRecord } from '../work-unit/manager.js';
import { rootsOf } from '../work-unit/policy.js';
import { leadingRootOf, modelFor } from '../work-unit/record.js';
import type { CronTaskEntry } from './lick-manager.js';
import type { RegisteredScoop, ScoopTabState } from './types.js';

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

/**
 * What an allow-list sync did to an existing unit. `deferred` means the file
 * asks for a different list and the unit is mid-pass, so nothing was touched.
 */
export type GelatiereAllowListOutcome = 'unchanged' | 'updated' | 'deferred';

/** What `gelatiere init` gets back. */
export interface GelatiereUnitInfo {
  folder: string;
  jid: string;
  created: boolean;
  /** What the file's allow-list did to an existing record. Absent on creation. */
  allowList?: GelatiereAllowListOutcome;
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
  /**
   * Create the unit if it is missing; idempotent. Throws
   * {@link GelatiereFolderTakenError}. `allowedCommands` — the merged list
   * from `GELATIERE.md` — is applied to an EXISTING record too, so editing the
   * file and rebooting (or running `gelatiere init`) takes effect on a unit
   * that is registered once and then lives for weeks. Omitted, the record is
   * left alone: callers without the file at hand (`gelatiere run`) must not
   * silently reset the list to the base set.
   */
  ensureUnit(allowedCommands?: readonly string[]): Promise<GelatiereUnitInfo>;
  /**
   * Unregister every unit under the synthetic owner — the gelatiere itself
   * and any mis-foldered twin an earlier boot minted. Returns their jids.
   */
  unregisterOwned(): Promise<string[]>;
  /** The unit, when it exists. */
  unit(): GelatiereRoot | undefined;
  /**
   * The allow-list the unit actually runs under — its record's, which is what
   * its context was built from. `undefined` when there is no unit. Read by
   * `gelatiere status`, which must report the policy in force rather than
   * whatever `GELATIERE.md` currently asks for.
   */
  unitAllowedCommands(): readonly string[] | undefined;
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
  /** Persist an in-place mutation of an already-registered record. */
  persistScoop(scoop: RegisteredScoop): Promise<void>;
  /**
   * Rebuild the live unit so a policy change reaches the running agent: the
   * shell's allow-list is read from the descriptor when the context is built,
   * so a mutated record alone would not move it. A no-op when the unit has no
   * live context, which is the boot case.
   */
  reinitLiveUnit(jid: string): Promise<void>;
  /** Persist and hot-resolve the gelatiere from the canonical leading cone. */
  syncGelatiereModel(): Promise<boolean>;
  /** Live tab state, for the `processing` probe that protects a pass in flight. */
  getScoopTabState(jid: string): { status: ScoopTabState['status'] } | undefined;
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
 * The base allow-list lives in `base/gelatiere-store.ts`, beside the parser
 * that merges `GELATIERE.md`'s own `allowedCommands` block into it. Re-exported
 * here because this module is where the list is APPLIED to the record.
 */
export { GELATIERE_BASE_ALLOWED_COMMANDS };

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
 * Apply the file's allow-list to a unit that already exists. The gelatiere is
 * registered once and then persists, so without this an `allowedCommands`
 * edit would only reach a unit dropped and re-created by
 * `gelatiere init --reset` — the curator, which spawns a fresh agent per
 * pass, has no such problem.
 *
 * Record and live context move TOGETHER or not at all. Making the list
 * effective means rebuilding the context, which disposes the one in flight —
 * so while the unit is processing, neither half is touched and the caller is
 * told the edit is deferred. That keeps the record honest as "the list in
 * force" (it is what the next context is built from), which is what
 * `gelatiere status` reports.
 */
async function syncAllowedCommands(
  orchestrator: GelatiereOrchestrator,
  unit: RegisteredScoop,
  allowedCommands: readonly string[] | undefined
): Promise<GelatiereAllowListOutcome> {
  if (!allowedCommands) return 'unchanged';
  const current = unit.config?.allowedCommands ?? [];
  if (sameCommands(current, allowedCommands)) return 'unchanged';
  // A rebuild aborts the active turn and clears the agent's queues, so a pass
  // in flight outranks an allow-list edit — the user loses a nightly pass they
  // never asked to cancel, and any lick queued behind it.
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
    // `persistScoop` swaps its in-memory record BEFORE awaiting the store
    // write, so a rejected write leaves the cache holding a list that neither
    // the store nor the live context has — and the next call would compare
    // against it, see "unchanged", and skip the sync for good. Put the old
    // record back before reporting the failure.
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

/**
 * Register the gelatiere scoop when it is missing. It starts on the default
 * root's model — the same fallback `cone-create` uses — so it never needs a
 * model of its own configured. Silent (`notifyOnComplete: false`): its passes
 * announce themselves through `gelatiere deliver`, and a completion or idle
 * notice on top would land in the default root's chat after every pass.
 */
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
  // The folder is the lick address, so a foreign unit sitting on it would
  // make registration land on `gelatiere-2` — a unit nothing ever licks —
  // and every later boot would mint another. Refuse instead.
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

/** Publish the seam on `globalThis` (or `target`, for tests). */
export function publishGelatiereSeam(seam: GelatiereSeam, target: object = globalThis): void {
  (target as GelatiereGlobals)[GELATIERE_SEAM_GLOBAL_KEY] = seam;
}

/**
 * Boot-time hook: with the `memory-v2` flag on, make sure the unit, its
 * nightly crontask and its allow-list match `/shared/GELATIERE.md`.
 * Best-effort — a failure here logs and leaves the manual `gelatiere init`
 * path.
 */
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
