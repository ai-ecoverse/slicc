// Types duplicated from packages/webapp for package isolation

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

export interface LickManager {
  createCronTask(
    name: string,
    cron: string,
    scoop?: string,
    filter?: string
  ): Promise<CronTaskEntry>;
  listCronTasks(): CronTaskEntry[];
  deleteCronTask(id: string): Promise<boolean>;
}

export interface ScoopTabState {
  jid: string;
  contextId: string;
  status: 'initializing' | 'ready' | 'processing' | 'error';
  lastActivity: string;
  error?: string;
}
