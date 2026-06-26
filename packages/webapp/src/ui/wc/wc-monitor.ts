/**
 * Monitor surface for the WC workbench: read-only dashboard of all resources
 * managed by SLICC — scoops, cron tasks, webhooks, mounts, MCP servers,
 * and OAuth accounts.
 */

import type { MountTableEntry } from '../../fs/mount-table-store.js';
import type { CronTaskEntry, WebhookEntry } from '../../scoops/lick-manager.js';
import type { RegisteredScoop } from '../../scoops/types.js';

export interface MonitorDeps {
  getScoops(): RegisteredScoop[];
  isProcessing(jid: string): boolean;
  getCronTasks(): Promise<CronTaskEntry[]>;
  getWebhooks(): Promise<WebhookEntry[]>;
  getMounts(): Promise<MountTableEntry[]>;
  getMcpServers(): Promise<Record<string, { url: string; tools?: unknown[] }>>;
  getOAuthProviders(): string[];
  getSessionStats(): Promise<{
    totalCost: number;
    models: { model: string; cost: number }[];
    scoops: { name: string; cost: number }[];
  } | null>;
  getProcesses(): Promise<{ pid: number; argv: string; status: string }[]>;
}

interface SectionDef {
  id: string;
  label: string;
  render(container: HTMLElement): Promise<void> | void;
}

const COLLAPSE_KEY = 'slicc_monitor_collapsed';

function getCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function setCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* localStorage unavailable */
  }
}

function createRow(name: string, meta: string, active?: boolean, error?: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'monitor-row';
  const dot = document.createElement('span');
  dot.className = `monitor-row__dot${active ? ' monitor-row__dot--active' : ''}${error ? ' monitor-row__dot--error' : ''}`;
  const nameEl = document.createElement('span');
  nameEl.className = 'monitor-row__name';
  nameEl.textContent = name;
  const metaEl = document.createElement('span');
  metaEl.className = 'monitor-row__meta';
  metaEl.textContent = meta;
  row.append(dot, nameEl, metaEl);
  return row;
}

function createSection(
  id: string,
  label: string,
  count: number,
  collapsed: Set<string>,
  meta?: string
): { section: HTMLElement; body: HTMLElement } {
  const section = document.createElement('div');
  section.className = 'monitor-section';
  section.dataset.section = id;
  if (count === 0) section.classList.add('monitor-section--empty');

  const header = document.createElement('button');
  header.className = 'monitor-section__header';
  const isCollapsed = collapsed.has(id);
  header.setAttribute('aria-expanded', String(!isCollapsed));

  const toggle = document.createElement('span');
  toggle.className = 'monitor-section__toggle';
  toggle.textContent = isCollapsed ? '▸' : '▾';

  const title = document.createElement('span');
  title.className = 'monitor-section__title';
  title.textContent = label;

  const badge = document.createElement('span');
  badge.className = 'monitor-section__count';
  badge.textContent = String(count);

  if (meta) {
    const metaEl = document.createElement('span');
    metaEl.className = 'monitor-section__meta';
    metaEl.textContent = meta;
    header.append(toggle, title, metaEl, badge);
  } else {
    header.append(toggle, title, badge);
  }

  const body = document.createElement('div');
  body.className = 'monitor-section__body';
  if (isCollapsed) body.setAttribute('hidden', '');

  header.addEventListener('click', () => {
    const nowExpanded = body.hasAttribute('hidden');
    if (nowExpanded) {
      body.removeAttribute('hidden');
      toggle.textContent = '▾';
      header.setAttribute('aria-expanded', 'true');
      collapsed.delete(id);
    } else {
      body.setAttribute('hidden', '');
      toggle.textContent = '▸';
      header.setAttribute('aria-expanded', 'false');
      collapsed.add(id);
    }
    setCollapsed(collapsed);
  });

  section.append(header, body);
  return { section, body };
}

export async function buildMonitorSections(deps: MonitorDeps): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.className = 'wcui-monitor';
  const collapsed = getCollapsed();

  const scoops = deps.getScoops();
  const [cronTasks, webhooks, mounts, mcpServers, sessionStats, processes] = await Promise.all([
    deps.getCronTasks().catch(() => [] as CronTaskEntry[]),
    deps.getWebhooks().catch(() => [] as WebhookEntry[]),
    deps.getMounts().catch(() => [] as MountTableEntry[]),
    deps.getMcpServers().catch(() => ({}) as Record<string, { url: string; tools?: unknown[] }>),
    deps.getSessionStats().catch(() => null),
    deps.getProcesses().catch(() => []),
  ]);
  const oauthProviders = deps.getOAuthProviders();
  const mcpEntries = Object.entries(mcpServers);

  const sections: SectionDef[] = [
    {
      id: 'cost',
      label: 'Cost',
      render(body) {
        if (sessionStats && sessionStats.models.length > 0) {
          for (const modelEntry of sessionStats.models) {
            body.append(createRow(modelEntry.model, `$${modelEntry.cost.toFixed(4)}`));
          }
        }
      },
    },
    {
      id: 'scoops',
      label: 'Scoops',
      render(body) {
        for (const scoop of scoops) {
          const label = scoop.isCone ? `${scoop.name || 'sliccy'} (cone)` : scoop.name;
          const processing = deps.isProcessing(scoop.jid);
          body.append(createRow(label, processing ? 'processing' : 'idle', processing));
        }
      },
    },
    {
      id: 'processes',
      label: 'Processes',
      render(body) {
        for (const proc of processes) {
          const shortArgv = proc.argv.length > 40 ? proc.argv.slice(0, 37) + '...' : proc.argv;
          const statusDot = proc.status === 'running';
          body.append(createRow(`${proc.pid}`, shortArgv, statusDot));
        }
      },
    },
    {
      id: 'cron',
      label: 'Cron Tasks',
      render(body) {
        for (const task of cronTasks) {
          body.append(createRow(task.name, task.cron, task.status === 'active'));
        }
      },
    },
    {
      id: 'webhooks',
      label: 'Webhooks',
      render(body) {
        for (const wh of webhooks) {
          body.append(createRow(wh.name, wh.scoop ? `→ ${wh.scoop}` : '→ cone'));
        }
      },
    },
    {
      id: 'workflows',
      label: 'Workflows',
      render(body) {
        // Workflows run in the kernel worker — reading their state requires
        // a panel-RPC round-trip. For v1, this section is populated but empty
        // unless the caller injects workflow data in a future iteration.
      },
    },
    {
      id: 'mounts',
      label: 'Mounts',
      render(body) {
        for (const mount of mounts) {
          body.append(createRow(mount.targetPath, mount.descriptor.kind));
        }
      },
    },
    {
      id: 'mcp',
      label: 'MCP Servers',
      render(body) {
        for (const [name, entry] of mcpEntries) {
          const toolCount = entry.tools?.length ?? 0;
          body.append(createRow(name, `${toolCount} tool${toolCount !== 1 ? 's' : ''}`));
        }
      },
    },
    {
      id: 'oauth',
      label: 'OAuth',
      render(body) {
        for (const provider of oauthProviders) {
          body.append(createRow(provider, ''));
        }
      },
    },
  ];

  for (const def of sections) {
    let count = 0;
    let meta: string | undefined;
    if (def.id === 'cost') {
      count = sessionStats?.models.length ?? 0;
      meta = sessionStats ? `$${sessionStats.totalCost.toFixed(2)}` : undefined;
    } else if (def.id === 'scoops') count = scoops.length;
    else if (def.id === 'processes') count = processes.length;
    else if (def.id === 'cron') count = cronTasks.length;
    else if (def.id === 'webhooks') count = webhooks.length;
    else if (def.id === 'workflows') count = 0;
    else if (def.id === 'mounts') count = mounts.length;
    else if (def.id === 'mcp') count = mcpEntries.length;
    else if (def.id === 'oauth') count = oauthProviders.length;

    const { section, body } = createSection(def.id, def.label, count, collapsed, meta);
    def.render(body);
    root.append(section);
  }

  return root;
}
