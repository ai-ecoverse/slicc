import { createLogger } from '../base/logger.js';
import { discoveryFingerprint } from '../net/discovery-link.js';
import { handoffFingerprint } from '../net/handoff-link.js';
import { getNextCronTime } from './cron.js';
import * as db from './db.js';

const log = createLogger('lick-manager');

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

import type { LickEvent, WebhookDeliveryDisposition } from '@slicc/shared-ts';

export type { LickEvent, WebhookDeliveryDisposition } from '@slicc/shared-ts';

export interface LickTargetUnit {
  name: string;
  folder: string;
}

export type LickTargetResolution =
  | { status: 'resolved' }
  | { status: 'unresolved'; candidates: string[] }
  | { status: 'unverifiable' };

export type LickEventHandler = (event: LickEvent) => void;

export const FORWARDABLE_TO_LEADER: ReadonlySet<LickEvent['type']> = new Set<LickEvent['type']>([
  'navigate',
  'discovery',
]);

interface NavigateFingerprintBody {
  verb?: unknown;
  target?: unknown;
  branch?: unknown;
  path?: unknown;
  instruction?: unknown;
  title?: unknown;
}

function navigateFingerprint(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as NavigateFingerprintBody;
  if (typeof b.verb !== 'string' || typeof b.target !== 'string') return null;
  return handoffFingerprint({
    verb: b.verb,
    target: b.target,
    branch: typeof b.branch === 'string' ? b.branch : undefined,
    path: typeof b.path === 'string' ? b.path : undefined,
    instruction: typeof b.instruction === 'string' ? b.instruction : undefined,
  });
}

function discoveryEventFingerprint(event: LickEvent): string | null {
  if (!event.discoveryKind && !event.discoveryUrl && !event.discoveryOrigin) return null;
  return discoveryFingerprint({
    origin: event.discoveryOrigin,
    kind: event.discoveryKind,
    url: event.discoveryUrl,
  });
}

export class LickManager {
  private webhooks = new Map<string, WebhookEntry>();
  private crontasks = new Map<string, CronTaskEntry>();
  private cronInterval: ReturnType<typeof setInterval> | null = null;
  private eventHandler: LickEventHandler | null = null;
  private forwarder: LickEventHandler | null = null;

  private seenNavigateFingerprints = new Set<string>();

  private seenDiscoveryFingerprints = new Set<string>();

  private unitRoster: (() => readonly LickTargetUnit[]) | null = null;

  private discoveryIgnore: ((event: LickEvent) => boolean) | null = null;

  async init(): Promise<void> {
    await db.initDB();

    const webhooks = await db.getAllWebhooks();
    for (const wh of webhooks) {
      this.webhooks.set(wh.id, wh);
    }
    log.info('Loaded webhooks', { count: this.webhooks.size });

    const crontasks = await db.getAllCronTasks();
    for (const ct of crontasks) {
      this.crontasks.set(ct.id, ct);
    }
    log.info('Loaded crontasks', { count: this.crontasks.size });

    await this.reconcileOrphans();

    this.cronInterval = setInterval(() => this.runCronScheduler(), 60000);
    log.info('Cron scheduler started');
  }

  setUnitRosterProvider(provider: (() => readonly LickTargetUnit[]) | null): void {
    this.unitRoster = provider;
  }

  resolveLickTarget(target: string): LickTargetResolution {
    const units = this.unitRoster?.();
    if (!units) return { status: 'unverifiable' };
    if (units.some((u) => lickScoopMatches(target, u.name, u.folder)))
      return { status: 'resolved' };
    return { status: 'unresolved', candidates: lickTargetCandidates(units) };
  }

  setDiscoveryIgnore(resolver: ((event: LickEvent) => boolean) | null): void {
    this.discoveryIgnore = resolver;
  }

  private isOrphanedLick(scoopField: string | undefined): boolean {
    if (!scoopField) return false;
    return this.resolveLickTarget(scoopField).status === 'unresolved';
  }

  private async reconcileOrphans(): Promise<void> {
    if (!this.unitRoster) return;
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

  dispose(): void {
    if (this.cronInterval) {
      clearInterval(this.cronInterval);
      this.cronInterval = null;
    }
  }

  setEventHandler(handler: LickEventHandler): void {
    this.eventHandler = handler;
  }

  setForwarder(forwarder: LickEventHandler | null): void {
    this.forwarder = forwarder;
  }

  private dispatch(event: LickEvent): void {
    if (event.type === 'discovery' && this.shouldSuppressDiscovery(event)) return;
    if (this.forwarder && FORWARDABLE_TO_LEADER.has(event.type)) {
      this.forwarder(event);
      return;
    }
    this.eventHandler?.(event);
  }

  handleForwardedEvent(event: LickEvent): void {
    if (event.type === 'discovery' && this.shouldSuppressDiscovery(event)) return;
    if (this.isDuplicateFingerprint(event)) return;
    this.eventHandler?.(event);
  }

  emitEvent(event: LickEvent): void {
    if (event.type === 'discovery' && this.shouldSuppressDiscovery(event)) return;
    if (this.isDuplicateFingerprint(event)) return;
    log.info('External lick event', { type: event.type, target: event.targetScoop });
    this.dispatch(event);
  }

  private isDuplicateFingerprint(event: LickEvent): boolean {
    let fingerprint: string | null = null;
    let seen: Set<string>;
    let label: string;
    if (event.type === 'navigate') {
      fingerprint = navigateFingerprint(event.body);
      seen = this.seenNavigateFingerprints;
      label = 'navigate';
    } else if (event.type === 'discovery') {
      fingerprint = discoveryEventFingerprint(event);
      seen = this.seenDiscoveryFingerprints;
      label = 'discovery';
    } else {
      return false;
    }
    if (fingerprint === null) return false;
    if (seen.has(fingerprint)) {
      log.debug(`Suppressing duplicate ${label} lick`, { fingerprint });
      return true;
    }
    seen.add(fingerprint);
    return false;
  }

  private shouldSuppressDiscovery(event: LickEvent): boolean {
    if (event.discoverySource !== 'live-navigation') {
      log.debug('Suppressing discovery without live-navigation provenance');
      return true;
    }
    if (this.discoveryIgnore?.(event)) {
      log.debug('Suppressing ignored llms.txt discovery', { origin: event.discoveryOrigin });
      return true;
    }
    return false;
  }

  async createWebhook(name: string, scoop?: string, filter?: string): Promise<WebhookEntry> {
    const id = this.generateId();
    const entry: WebhookEntry = {
      id,
      name,
      createdAt: new Date().toISOString(),
      filter,
      scoop,
    };

    if (filter) {
      this.compileFilter(filter, true);
    }

    this.webhooks.set(id, entry);
    await db.saveWebhook(entry);
    log.info('Webhook created', { id, name, scoop });
    return entry;
  }

  async deleteWebhook(id: string): Promise<boolean> {
    if (this.webhooks.has(id)) {
      this.webhooks.delete(id);
      await db.deleteWebhook(id);
      log.info('Webhook deleted', { id });
      return true;
    }

    if ((await db.getWebhook(id)) !== null) {
      await db.deleteWebhook(id);
      log.info('Webhook deleted', { id });
      return true;
    }
    return false;
  }

  listWebhooks(): WebhookEntry[] {
    return Array.from(this.webhooks.values());
  }

  getWebhook(id: string): WebhookEntry | undefined {
    return this.webhooks.get(id);
  }

  handleWebhookEvent(
    webhookId: string,
    headers: Record<string, string>,
    body: unknown
  ): WebhookDeliveryDisposition {
    const webhook = this.webhooks.get(webhookId);
    if (!webhook) {
      log.warn('Webhook not found', { webhookId });
      return 'unknown-webhook';
    }

    if (this.isOrphanedLick(webhook.scoop)) {
      log.warn('Webhook target scoop not found — dropping delivery', {
        webhookId,
        name: webhook.name,
        scoop: webhook.scoop,
      });
      return 'unresolved-target';
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

    if (webhook.filter) {
      try {
        const filterFn = this.compileFilter(webhook.filter, true);
        const result = filterFn(event);
        if (result === false) {
          log.debug('Webhook event dropped by filter', { webhookId, name: webhook.name });
          return 'filtered';
        }
        if (typeof result === 'object' && result !== null) {
          event = result as LickEvent;
        }
      } catch (err) {
        log.error('Webhook filter error', {
          webhookId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('Webhook event received', {
      webhookId,
      name: webhook.name,
      targetScoop: webhook.scoop,
    });
    this.dispatch(event);
    return 'delivered';
  }

  async createCronTask(
    name: string,
    cron: string,
    scoop?: string,
    filter?: string
  ): Promise<CronTaskEntry> {
    const nextRun = getNextCronTime(cron, new Date());
    if (!nextRun) {
      throw new Error('Invalid cron expression');
    }

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

  async deleteCronTask(id: string): Promise<boolean> {
    if (this.crontasks.has(id)) {
      this.crontasks.delete(id);
      await db.deleteCronTask(id);
      log.info('Cron task deleted', { id });
      return true;
    }

    if ((await db.getCronTask(id)) !== null) {
      await db.deleteCronTask(id);
      log.info('Cron task deleted', { id });
      return true;
    }
    return false;
  }

  listCronTasks(): CronTaskEntry[] {
    return Array.from(this.crontasks.values());
  }

  getCronTask(id: string): CronTaskEntry | undefined {
    return this.crontasks.get(id);
  }

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

  private async runCronScheduler(): Promise<void> {
    const now = new Date();

    for (const task of this.crontasks.values()) {
      if (await this.deleteIfOrphanedCron(task)) continue;

      if (task.status !== 'active') continue;
      if (!task.nextRun) continue;

      const nextRun = new Date(task.nextRun);
      if (nextRun > now) continue;

      await this.runDueCronTask(task, now);
    }
  }

  private async runDueCronTask(task: CronTaskEntry, now: Date): Promise<void> {
    let payload: unknown = { time: now.toISOString() };

    if (task.filter) {
      try {
        const filterFn = this.compileFilter(task.filter, false);
        const result = filterFn(null);
        if (result === false) {
          log.debug('Cron task skipped by filter', { id: task.id, name: task.name });

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

    const next = getNextCronTime(task.cron, now);
    task.nextRun = next?.toISOString() ?? null;
    task.lastRun = now.toISOString();
    await db.saveCronTask(task);
  }

  private generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 12; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }

  private compileFilter(
    filterCode: string,
    isWebhook: boolean
  ): (event: unknown) => boolean | unknown {
    try {
      if (isWebhook) {
        return new Function('event', `return (${filterCode})(event);`) as (
          event: unknown
        ) => boolean | unknown;
      } else {
        return new Function(`return (${filterCode})();`) as () => boolean | unknown;
      }
    } catch (err) {
      throw new Error(
        `Invalid filter function: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

export function lickScoopMatches(
  scoopField: string | undefined,
  name: string,
  folder: string
): boolean {
  if (!scoopField) return false;
  return scoopField === name || scoopField === folder || `${scoopField}-scoop` === folder;
}

export function lickTargetCandidates(units: readonly LickTargetUnit[]): string[] {
  const seen = new Set<string>();
  for (const unit of units) {
    seen.add(unit.folder);
    if (unit.name && unit.name !== unit.folder) seen.add(unit.name);
  }
  return Array.from(seen);
}

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

let instance: LickManager | null = null;

export function getLickManager(): LickManager {
  if (!instance) {
    instance = new LickManager();
  }
  return instance;
}
