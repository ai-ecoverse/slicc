// Narrowed surface of `packages/webapp`'s `LickManager` that the
// BroadcastChannel proxy is willing to forward across the offscreen /
// side-panel boundary. The interface deliberately omits lifecycle
// (`init`, `dispose`), event-source registration (`setEventHandler`),
// and dispatch (`emitEvent`, `handleWebhookEvent`) — those are
// kernel-host concerns that must not cross runtime contexts.
//
// `CronTaskEntry` and `WebhookEntry` are duplicated here to keep this
// file dependency-free from `packages/webapp`. A structural-type-
// equality assertion in `tests/lick-manager-proxy.test.ts` enforces
// that both definitions stay in sync — if a canonical field shape
// shifts in `webapp/src/scoops/lick-manager.ts`, the test fails to
// compile.

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

export interface LickManager {
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

export interface ScoopTabState {
  jid: string;
  contextId: string;
  status: 'initializing' | 'ready' | 'processing' | 'error';
  lastActivity: string;
  error?: string;
}
