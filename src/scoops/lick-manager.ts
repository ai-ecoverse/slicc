/**
 * Lick Manager - Browser-side management of webhooks and crontasks.
 * 
 * All state is stored in IndexedDB. The server only forwards raw webhook
 * POSTs to the browser via WebSocket - all filtering and routing happens here.
 */

import { createLogger } from '../core/logger.js';
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

export interface LickEvent {
  type: 'webhook' | 'cron';
  webhookId?: string;
  webhookName?: string;
  cronId?: string;
  cronName?: string;
  targetScoop?: string;
  timestamp: string;
  headers?: Record<string, string>;
  body: unknown;
}

export type LickEventHandler = (event: LickEvent) => void;

// ─── Lick Manager ───────────────────────────────────────────────────────────

export class LickManager {
  private webhooks = new Map<string, WebhookEntry>();
  private crontasks = new Map<string, CronTaskEntry>();
  private cronInterval: ReturnType<typeof setInterval> | null = null;
  private eventHandler: LickEventHandler | null = null;

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

    // Start cron scheduler (every 60 seconds)
    this.cronInterval = setInterval(() => this.runCronScheduler(), 60000);
    log.info('Cron scheduler started');
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
        log.error('Webhook filter error', { webhookId, error: err instanceof Error ? err.message : String(err) });
        // Continue with original event on filter error
      }
    }

    log.info('Webhook event received', { webhookId, name: webhook.name, targetScoop: webhook.scoop });
    this.eventHandler?.(event);
  }

  // ─── Cron Tasks ───────────────────────────────────────────────────────────

  /** Create a new cron task */
  async createCronTask(name: string, cron: string, scoop?: string, filter?: string): Promise<CronTaskEntry> {
    // Validate cron expression
    const nextRun = this.getNextCronTime(cron, new Date());
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
  getLicksForScoop(name: string, folder: string): { webhooks: WebhookEntry[]; cronTasks: CronTaskEntry[] } {
    const matches = (scoopField: string | undefined): boolean =>
      scoopField === name || scoopField === folder || `${scoopField}-scoop` === folder;
    const webhooks = Array.from(this.webhooks.values()).filter(wh => matches(wh.scoop));
    const cronTasks = Array.from(this.crontasks.values()).filter(ct => matches(ct.scoop));
    return { webhooks, cronTasks };
  }

  /** Run the cron scheduler - called every minute */
  private async runCronScheduler(): Promise<void> {
    const now = new Date();
    
    for (const task of this.crontasks.values()) {
      if (task.status !== 'active') continue;
      if (!task.nextRun) continue;

      const nextRun = new Date(task.nextRun);
      if (nextRun > now) continue;

      // Task is due - run filter and dispatch
      let payload: unknown = { time: now.toISOString() };
      
      if (task.filter) {
        try {
          const filterFn = this.compileFilter(task.filter, false);
          const result = filterFn(null);
          if (result === false) {
            log.debug('Cron task skipped by filter', { id: task.id, name: task.name });
            // Update next run time even if skipped
            const next = this.getNextCronTime(task.cron, now);
            task.nextRun = next?.toISOString() ?? null;
            task.lastRun = now.toISOString();
            await db.saveCronTask(task);
            continue;
          }
          if (typeof result === 'object' && result !== null) {
            payload = result;
          }
        } catch (err) {
          log.error('Cron filter error', { id: task.id, error: err instanceof Error ? err.message : String(err) });
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
      this.eventHandler?.(event);

      // Update times
      const next = this.getNextCronTime(task.cron, now);
      task.nextRun = next?.toISOString() ?? null;
      task.lastRun = now.toISOString();
      await db.saveCronTask(task);
    }
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
  private compileFilter(filterCode: string, isWebhook: boolean): (event: unknown) => boolean | unknown {
    try {
      if (isWebhook) {
        // Webhook filter: (event) => ...
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        return new Function('event', `return (${filterCode})(event);`) as (event: unknown) => boolean | unknown;
      } else {
        // Cron filter: () => ...
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        return new Function(`return (${filterCode})();`) as () => boolean | unknown;
      }
    } catch (err) {
      throw new Error(`Invalid filter function: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Calculate next cron run time */
  private getNextCronTime(cron: string, from: Date): Date | null {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const next = new Date(from);
    next.setSeconds(0);
    next.setMilliseconds(0);
    next.setMinutes(next.getMinutes() + 1);

    const cronFieldMatches = (value: number, field: string): boolean => {
      if (field === '*') return true;
      if (field.includes(',')) {
        return field.split(',').some((f) => cronFieldMatches(value, f.trim()));
      }
      if (field.includes('-')) {
        const [start, end] = field.split('-').map((n) => parseInt(n, 10));
        return value >= start && value <= end;
      }
      if (field.includes('/')) {
        const [base, step] = field.split('/');
        const stepNum = parseInt(step, 10);
        if (base === '*') return value % stepNum === 0;
        const baseNum = parseInt(base, 10);
        return value >= baseNum && (value - baseNum) % stepNum === 0;
      }
      return parseInt(field, 10) === value;
    };

    // Search up to 1 year
    for (let i = 0; i < 527040; i++) {
      if (
        cronFieldMatches(next.getMinutes(), minute) &&
        cronFieldMatches(next.getHours(), hour) &&
        cronFieldMatches(next.getDate(), dayOfMonth) &&
        cronFieldMatches(next.getMonth() + 1, month) &&
        cronFieldMatches(next.getDay(), dayOfWeek)
      ) {
        return next;
      }
      next.setMinutes(next.getMinutes() + 1);
    }
    return null;
  }
}

/** Build the error thrown when trying to remove a scoop with active licks.
 *  Returns null if there are no active licks. Used by orchestrator and tests. */
export function buildActiveLicksError(
  scoopFolder: string,
  webhooks: WebhookEntry[],
  cronTasks: CronTaskEntry[],
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
    ...webhooks.map(wh => `  webhook delete ${wh.id}`),
    ...cronTasks.map(ct => `  crontask delete ${ct.id}`),
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
