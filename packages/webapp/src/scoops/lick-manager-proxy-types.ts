// Narrowed surface of the canonical `LickManager` (`./lick-manager.ts`)
// that the BroadcastChannel proxy is willing to forward across the
// kernel-bridge / side-panel boundary. The interface deliberately omits
// lifecycle (`init`, `dispose`), event-source registration
// (`setEventHandler`), and dispatch (`emitEvent`, `handleWebhookEvent`)
// — those are kernel-host concerns that must not cross runtime contexts.
//
// `CronTaskEntry` and `WebhookEntry` are duplicated here so this file
// stays free of any dependency on the full `lick-manager.ts` module. A
// structural-type-equality assertion in
// `tests/scoops/lick-manager-proxy.test.ts` enforces that both
// definitions stay in sync — if a canonical field shape shifts in
// `./lick-manager.ts`, the test fails to compile.

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
