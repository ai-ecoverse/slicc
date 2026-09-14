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

export interface WebhookEntry {
  id: string;
  name: string;
  createdAt: string;
  filter?: string;
  scoop?: string;
}

export type LickTargetResolution =
  | { status: 'resolved' }
  | { status: 'unresolved'; candidates: string[] }
  | { status: 'unverifiable' };

export interface LickManager {
  resolveLickTarget?(target: string): LickTargetResolution;
  createCronTask(
    name: string,
    cron: string,
    scoop?: string,
    filter?: string
  ): Promise<CronTaskEntry>;
  listCronTasks(): CronTaskEntry[];
  deleteCronTask(id: string): Promise<boolean>;
  createWebhook(name: string, scoop?: string, filter?: string): Promise<WebhookEntry>;
  listWebhooks(): WebhookEntry[];
  deleteWebhook(id: string): Promise<boolean>;
}
