/**
 * Lick Manager - Browser-side management of webhooks and crontasks.
 *
 * All state is stored in IndexedDB. The server only forwards raw webhook
 * POSTs to the browser via WebSocket - all filtering and routing happens here.
 */

import { createLogger } from '../core/logger.js';
import { discoveryFingerprint } from '../net/discovery-link.js';
import { handoffFingerprint } from '../net/handoff-link.js';
import { getNextCronTime } from './cron.js';
import * as db from './db.js';

const log = createLogger('lick-manager');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WebhookEntry {
  id: string;
  name: string;
  createdAt: string;
  filter?: string;
  scoop?: string;
}

export interface CronTaskEntry {
  id: string;
  name: string;
  cron: string;
  scoop?: string;
  filter?: string;
  nextRun: string | null;
  lastRun: string | null;
  status: 'active' | 'paused';
  createdAt: string;
}

// LickEvent is tray-sync wire format (follower `lick` forwarding) — canonical
// copy in @slicc/shared-ts; re-exported here so scoops/-layer importers keep
// their local import site.
import type { LickEvent } from '@slicc/shared-ts';

export type { LickEvent } from '@slicc/shared-ts';

export type LickEventHandler = (event: LickEvent) => void;

/**
 * Lick types that an `emitEvent`-emitting follower forwards to the
 * leader's agent (and that the leader accepts on the generic `lick`
 * tray message). `navigate` and `discovery` are both origin-scoped
 * events a follower observes on the page it drives — the leader is the
 * agent that acts on them, so they forward. `sprinkle` also belongs to
 * the leader's agent but forwards via its own dedicated `sprinkle.lick`
 * path; `cherry` is emitted ON the leader by
 * `Orchestrator.handleCherryHostEvent` after the leader receives a
 * `cherry.host_event` from a follower, so it's never a follower-side
 * forward source. Both are intentionally NOT here.
 */
export const FORWARDABLE_TO_LEADER: ReadonlySet<LickEvent['type']> = new Set<LickEvent['type']>([
  'navigate',
  'discovery',
]);

/**
 * Derive a stable dedup key from a navigate lick's body, or `null` if the body
 * lacks the structured handoff fields (in which case the event is let through
 * undeduped). The body is built by every navigate source (CDP watcher,
 * extension offscreen, lick-ws bridge) as `{ url, verb, target, branch?, path?,
 * instruction?, title? }`; we key on the payload identity, never the page
 * `url`. See {@link handoffFingerprint}.
 */
function navigateFingerprint(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.verb !== 'string' || typeof b.target !== 'string') return null;
  return handoffFingerprint({
    verb: b.verb,
    target: b.target,
    branch: typeof b.branch === 'string' ? b.branch : undefined,
    path: typeof b.path === 'string' ? b.path : undefined,
    instruction: typeof b.instruction === 'string' ? b.instruction : undefined,
  });
}

/**
 * Derive a stable dedup key from a discovery lick, or `null` when it lacks the
 * structured discovery fields (in which case the event is let through
 * undeduped). An origin can advertise the same `ai-catalog` rel / well-known
 * artifact on every page response, so we key on the artifact identity
 * (`discoveryOrigin` + `discoveryKind` + `discoveryUrl`), never the page url.
 * See {@link discoveryFingerprint}.
 */
function discoveryEventFingerprint(event: LickEvent): string | null {
  if (!event.discoveryKind && !event.discoveryUrl && !event.discoveryOrigin) return null;
  return discoveryFingerprint({
    origin: event.discoveryOrigin,
    kind: event.discoveryKind,
    url: event.discoveryUrl,
  });
}

// ─── Lick Manager ───────────────────────────────────────────────────────────

export class LickManager {
  private webhooks = new Map<string, WebhookEntry>();
  private crontasks = new Map<string, CronTaskEntry>();
  private cronInterval: ReturnType<typeof setInterval> | null = null;
  private eventHandler: LickEventHandler | null = null;
  private forwarder: LickEventHandler | null = null;
  /**
   * Payload fingerprints of navigate (handoff/upskill) licks already emitted
   * this session. A site can advertise the same SLICC `Link` rel on every page
   * response, so without this guard each navigation would wake the cone and
   * (in the extension) re-show a notification. Scoped to the instance so it
   * naturally re-arms on a fresh session / reset; `upskill`'s on-disk
   * "already exists" check still prevents duplicate installs on that one
   * re-fire. See {@link handoffFingerprint}.
   */
  private seenNavigateFingerprints = new Set<string>();
  /**
   * Payload fingerprints of discovery licks already emitted this session.
   * Symmetric to {@link seenNavigateFingerprints}: an origin re-advertises the
   * same `ai-catalog` / `llms.txt` artifact on every navigation, so without
   * this guard each page load would re-notify the cone of the same manifest.
   * See {@link discoveryFingerprint}.
   */
  private seenDiscoveryFingerprints = new Set<string>();
  /**
   * Resolver injected by the orchestrator: given a lick's `scoop` field,
   * returns whether a matching scoop is still registered (using the same
   * alias matching as {@link getLicksForScoop}). Used to detect orphaned
   * licks at boot ({@link init}) and on every scheduler tick
   * ({@link runCronScheduler}). `null` until wired — every orphan check is a
   * no-op while unset, preserving pre-injection behavior (tests / early boot).
   */
  private scoopResolver: ((scoopField: string) => boolean) | null = null;

  /** Initialize - load from IndexedDB and start cron scheduler */
  async init(): Promise<void> {
    // Ensure DB is initialized (triggers schema upgrade if needed)
    await db.initDB();

    // Load webhooks from DB
    const webhooks = await db.getAllWebhooks();
    for (const wh of webhooks) {
      this.webhooks.set(wh.id, wh);
    }
    log.info('Loaded webhooks', { count: this.webhooks.size });

    // Load crontasks from DB
    const crontasks = await db.getAllCronTasks();
    for (const ct of crontasks) {
      this.crontasks.set(ct.id, ct);
    }
    log.info('Loaded crontasks', { count: this.crontasks.size });

    // Reconcile against the scoop-existence resolver (no-op if unwired):
    // drop any lick whose target scoop no longer exists before the scheduler
    // starts, so a stale crontask can't fire on boot.
    await this.reconcileOrphans();

    // Start cron scheduler (every 60 seconds)
    this.cronInterval = setInterval(() => this.runCronScheduler(), 60000);
    log.info('Cron scheduler started');
  }

  /**
   * Inject the scoop-existence resolver (or clear it with `null`). The
   * orchestrator wires this in `setLickManager` using the shared alias
   * matching so orphaned-lick detection follows the same name / folder /
   * `<scoop>-scoop` rules as {@link getLicksForScoop}.
   */
  setScoopExistenceResolver(resolver: ((scoopField: string) => boolean) | null): void {
    this.scoopResolver = resolver;
  }

  /** True when `scoopField` is set but resolves to no registered scoop. */
  private isOrphanedLick(scoopField: string | undefined): boolean {
    if (!this.scoopResolver || !scoopField) return false;
    return !this.scoopResolver(scoopField);
  }

  /**
   * Remove orphaned licks — those whose `scoop` field is set but resolves to
   * a scoop that no longer exists. No-op when no resolver is wired. Called at
   * boot from {@link init} so a scoop deleted while its tab was closed can't
   * leave a firing crontask or a live webhook behind.
   */
  private async reconcileOrphans(): Promise<void> {
    if (!this.scoopResolver) return;
    for (const wh of Array.from(this.webhooks.values())) {
      if (!this.isOrphanedLick(wh.scoop)) continue;
      log.warn('Removing orphaned webhook at init; target scoop no longer exists', {
        id: wh.id,
        name: wh.name,
        scoop: wh.scoop,
      });
      this.webhooks.delete(wh.id);
      try {
        await db.deleteWebhook(wh.id);
      } catch (err) {
        log.warn('Failed to delete orphaned webhook from DB', {
          id: wh.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const ct of Array.from(this.crontasks.values())) {
      if (!this.isOrphanedLick(ct.scoop)) continue;
      log.warn('Removing orphaned cron task at init; target scoop no longer exists', {
        id: ct.id,
        name: ct.name,
        scoop: ct.scoop,
      });
      this.crontasks.delete(ct.id);
      try {
        await db.deleteCronTask(ct.id);
      } catch (err) {
        log.warn('Failed to delete orphaned cron task from DB', {
          id: ct.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Clean up */
  dispose(): void {
    if (this.cronInterval) {
      clearInterval(this.cronInterval);
      this.cronInterval = null;
    }
  }

  /** Set the handler for lick events */
  setEventHandler(handler: LickEventHandler): void {
    this.eventHandler = handler;
  }

  /**
   * Install a forwarder (follower mode) or clear it (leader/standalone,
   * pass `null`). When set, forwardable lick types are shipped to the
   * leader via the forwarder instead of running the local handler.
   */
  setForwarder(forwarder: LickEventHandler | null): void {
    this.forwarder = forwarder;
  }

  /**
   * Single dispatch chokepoint. Every emit site (emitEvent, webhook,
   * cron) routes through here so the forwarder gate is consistent.
   */
  private dispatch(event: LickEvent): void {
    if (this.forwarder && FORWARDABLE_TO_LEADER.has(event.type)) {
      this.forwarder(event);
      return;
    }
    this.eventHandler?.(event);
  }

  /** Emit an externally-generated lick event (e.g., from fswatch). */
  emitEvent(event: LickEvent): void {
    if (event.type === 'navigate') {
      const fingerprint = navigateFingerprint(event.body);
      if (fingerprint !== null) {
        if (this.seenNavigateFingerprints.has(fingerprint)) {
          log.debug('Suppressing duplicate navigate lick', { fingerprint });
          return;
        }
        this.seenNavigateFingerprints.add(fingerprint);
      }
    } else if (event.type === 'discovery') {
      const fingerprint = discoveryEventFingerprint(event);
      if (fingerprint !== null) {
        if (this.seenDiscoveryFingerprints.has(fingerprint)) {
          log.debug('Suppressing duplicate discovery lick', { fingerprint });
          return;
        }
        this.seenDiscoveryFingerprints.add(fingerprint);
      }
    }
    log.info('External lick event', { type: event.type, target: event.targetScoop });
    this.dispatch(event);
  }

  // ─── Webhooks ─────────────────────────────────────────────────────────────

  /** Create a new webhook */
  async createWebhook(name: string, scoop?: string, filter?: string): Promise<WebhookEntry> {
    const id = this.generateId();
    const entry: WebhookEntry = {
      id,
      name,
      createdAt: new Date().toISOString(),
      filter,
      scoop,
    };

    // Validate filter if provided
    if (filter) {
      this.compileFilter(filter, true);
    }

    this.webhooks.set(id, entry);
    await db.saveWebhook(entry);
    log.info('Webhook created', { id, name, scoop });
    return entry;
  }

  /** Delete a webhook */
  async deleteWebhook(id: string): Promise<boolean> {
    if (!this.webhooks.has(id)) return false;
    this.webhooks.delete(id);
    await db.deleteWebhook(id);
    log.info('Webhook deleted', { id });
    return true;
  }

  /** List all webhooks */
  listWebhooks(): WebhookEntry[] {
    return Array.from(this.webhooks.values());
  }

  /** Get webhook by ID */
  getWebhook(id: string): WebhookEntry | undefined {
    return this.webhooks.get(id);
  }

  /** Handle incoming webhook event from server */
  handleWebhookEvent(webhookId: string, headers: Record<string, string>, body: unknown): void {
    const webhook = this.webhooks.get(webhookId);
    if (!webhook) {
      log.warn('Webhook not found', { webhookId });
      return;
    }

    let event: LickEvent = {
      type: 'webhook',
      webhookId,
      webhookName: webhook.name,
      targetScoop: webhook.scoop,
      timestamp: new Date().toISOString(),
      headers,
      body,
    };

    // Apply filter if defined
    if (webhook.filter) {
      try {
        const filterFn = this.compileFilter(webhook.filter, true);
        const result = filterFn(event);
        if (result === false) {
          log.debug('Webhook event dropped by filter', { webhookId, name: webhook.name });
          return;
        }
        if (typeof result === 'object' && result !== null) {
          event = result as LickEvent;
        }
      } catch (err) {
        log.error('Webhook filter error', {
          webhookId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue with original event on filter error
      }
    }

    log.info('Webhook event received', {
      webhookId,
      name: webhook.name,
      targetScoop: webhook.scoop,
    });
    this.dispatch(event);
  }

  // ─── Cron Tasks ───────────────────────────────────────────────────────────

  /** Create a new cron task */
  async createCronTask(
    name: string,
    cron: string,
    scoop?: string,
    filter?: string
  ): Promise<CronTaskEntry> {
    // Validate cron expression
    const nextRun = getNextCronTime(cron, new Date());
    if (!nextRun) {
      throw new Error('Invalid cron expression');
    }

    // Validate filter if provided
    if (filter) {
      this.compileFilter(filter, false);
    }

    const id = this.generateId();
    const entry: CronTaskEntry = {
      id,
      name,
      cron,
      scoop,
      filter,
      nextRun: nextRun.toISOString(),
      lastRun: null,
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    this.crontasks.set(id, entry);
    await db.saveCronTask(entry);
    log.info('Cron task created', { id, name, cron, scoop });
    return entry;
  }

  /** Delete a cron task */
  async deleteCronTask(id: string): Promise<boolean> {
    if (!this.crontasks.has(id)) return false;
    this.crontasks.delete(id);
    await db.deleteCronTask(id);
    log.info('Cron task deleted', { id });
    return true;
  }

  /** List all cron tasks */
  listCronTasks(): CronTaskEntry[] {
    return Array.from(this.crontasks.values());
  }

  /** Get cron task by ID */
  getCronTask(id: string): CronTaskEntry | undefined {
    return this.crontasks.get(id);
  }

  /** Get all webhooks and cron tasks targeting a scoop by name or folder.
   *  Mirrors the alias matching used in lick routing (main.ts):
   *  - exact match on name
   *  - exact match on folder
   *  - wh.scoop + '-scoop' matches folder (e.g. webhook scoop="click-handler", folder="click-handler-scoop")
   */
  getLicksForScoop(
    name: string,
    folder: string
  ): { webhooks: WebhookEntry[]; cronTasks: CronTaskEntry[] } {
    const webhooks = Array.from(this.webhooks.values()).filter((wh) =>
      lickScoopMatches(wh.scoop, name, folder)
    );
    const cronTasks = Array.from(this.crontasks.values()).filter((ct) =>
      lickScoopMatches(ct.scoop, name, folder)
    );
    return { webhooks, cronTasks };
  }

  /**
   * Persistence-authoritative variant of {@link getLicksForScoop}: reads the
   * webhooks / cron tasks straight from IndexedDB rather than the in-memory
   * maps. Used by the unregister guard so a lick persisted by another worker
   * (but not yet loaded into this instance) still blocks a scoop drop.
   */
  async getLicksForScoopFromDb(
    name: string,
    folder: string
  ): Promise<{ webhooks: WebhookEntry[]; cronTasks: CronTaskEntry[] }> {
    const [allWebhooks, allCronTasks] = await Promise.all([
      db.getAllWebhooks(),
      db.getAllCronTasks(),
    ]);
    const webhooks = allWebhooks.filter((wh) => lickScoopMatches(wh.scoop, name, folder));
    const cronTasks = allCronTasks.filter((ct) => lickScoopMatches(ct.scoop, name, folder));
    return { webhooks, cronTasks };
  }

  /**
   * Self-heal: if `task` targets a scoop that no longer exists, drop it from
   * memory + persistence and return `true` (the scheduler must skip it). No-op
   * returning `false` when a resolver is unwired or the target still exists.
   */
  private async deleteIfOrphanedCron(task: CronTaskEntry): Promise<boolean> {
    if (!this.isOrphanedLick(task.scoop)) return false;
    log.warn('Deleting orphaned cron task; target scoop no longer exists', {
      id: task.id,
      name: task.name,
      scoop: task.scoop,
    });
    this.crontasks.delete(task.id);
    try {
      await db.deleteCronTask(task.id);
    } catch (err) {
      log.warn('Failed to delete orphaned cron task from DB', {
        id: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  /** Run the cron scheduler - called every minute */
  private async runCronScheduler(): Promise<void> {
    const now = new Date();

    for (const task of this.crontasks.values()) {
      // A task whose target scoop is gone must never fire again — drop it.
      if (await this.deleteIfOrphanedCron(task)) continue;

      if (task.status !== 'active') continue;
      if (!task.nextRun) continue;

      const nextRun = new Date(task.nextRun);
      if (nextRun > now) continue;

      await this.runDueCronTask(task, now);
    }
  }

  /** Run a single due cron task: apply its filter, dispatch, and reschedule. */
  private async runDueCronTask(task: CronTaskEntry, now: Date): Promise<void> {
    let payload: unknown = { time: now.toISOString() };

    if (task.filter) {
      try {
        const filterFn = this.compileFilter(task.filter, false);
        const result = filterFn(null);
        if (result === false) {
          log.debug('Cron task skipped by filter', { id: task.id, name: task.name });
          // Update next run time even if skipped
          const next = getNextCronTime(task.cron, now);
          task.nextRun = next?.toISOString() ?? null;
          task.lastRun = now.toISOString();
          await db.saveCronTask(task);
          return;
        }
        if (typeof result === 'object' && result !== null) {
          payload = result;
        }
      } catch (err) {
        log.error('Cron filter error', {
          id: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Dispatch as a lick event
    const event: LickEvent = {
      type: 'cron',
      cronId: task.id,
      cronName: task.name,
      targetScoop: task.scoop,
      timestamp: now.toISOString(),
      body: payload,
    };

    log.info('Cron task running', { id: task.id, name: task.name });
    this.dispatch(event);

    // Update times
    const next = getNextCronTime(task.cron, now);
    task.nextRun = next?.toISOString() ?? null;
    task.lastRun = now.toISOString();
    await db.saveCronTask(task);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 12; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }

  /** Compile a filter function */
  private compileFilter(
    filterCode: string,
    isWebhook: boolean
  ): (event: unknown) => boolean | unknown {
    try {
      if (isWebhook) {
        // Webhook filter: (event) => ...
        // User-authored webhook/cron filter expression — evaluated in extension sandbox context.
        // The filterCode string comes from the user's skill/webhook config, not from remote input.

        return new Function('event', `return (${filterCode})(event);`) as (
          event: unknown
        ) => boolean | unknown;
      } else {
        // Cron filter: () => ...

        return new Function(`return (${filterCode})();`) as () => boolean | unknown;
      }
    } catch (err) {
      throw new Error(
        `Invalid filter function: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Shared alias matching between a lick's `scoop` field and a scoop's
 * `name` / `folder`:
 *  - exact match on name
 *  - exact match on folder
 *  - `scoopField + '-scoop'` matches folder (e.g. scoop="click-handler",
 *    folder="click-handler-scoop")
 * Used by {@link LickManager.getLicksForScoop}, the DB-backed lookup, and the
 * orchestrator's scoop-existence resolver so all three agree on matching.
 */
export function lickScoopMatches(
  scoopField: string | undefined,
  name: string,
  folder: string
): boolean {
  if (!scoopField) return false;
  return scoopField === name || scoopField === folder || `${scoopField}-scoop` === folder;
}

/** Build the error thrown when trying to remove a scoop with active licks.
 *  Returns null if there are no active licks. Used by orchestrator and tests. */
export function buildActiveLicksError(
  scoopFolder: string,
  webhooks: WebhookEntry[],
  cronTasks: CronTaskEntry[]
): Error | null {
  if (webhooks.length === 0 && cronTasks.length === 0) return null;
  const parts: string[] = [];
  if (webhooks.length > 0) {
    parts.push(`${webhooks.length} active webhook${webhooks.length > 1 ? 's' : ''}`);
  }
  if (cronTasks.length > 0) {
    parts.push(`${cronTasks.length} active cron task${cronTasks.length > 1 ? 's' : ''}`);
  }
  const commands = [
    ...webhooks.map((wh) => `  webhook delete ${wh.id}`),
    ...cronTasks.map((ct) => `  crontask delete ${ct.id}`),
  ].join('\n');
  return new Error(
    `Cannot remove scoop '${scoopFolder}': it has ${parts.join(' and ')}. Unregister them first:\n${commands}`
  );
}

/** Singleton instance */
let instance: LickManager | null = null;

export function getLickManager(): LickManager {
  if (!instance) {
    instance = new LickManager();
  }
  return instance;
}
