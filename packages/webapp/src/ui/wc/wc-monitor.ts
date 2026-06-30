/**
 * Monitor surface for the WC workbench: read-only dashboard of all resources
 * managed by SLICC — scoops, cron tasks, webhooks, mounts, MCP servers,
 * and OAuth accounts.
 */

import type { MonitorSection } from '@slicc/webcomponents';
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

/**
 * Fetch monitor data and return it as `MonitorSection[]` for the
 * `<slicc-monitor>` component.
 */
export async function fetchMonitorData(deps: MonitorDeps): Promise<MonitorSection[]> {
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

  const sections: MonitorSection[] = [
    {
      id: 'cost',
      label: 'Cost',
      count: sessionStats?.models.length ?? 0,
      meta: sessionStats ? `$${sessionStats.totalCost.toFixed(2)}` : undefined,
      rows:
        sessionStats?.models.map((m) => ({
          name: m.model,
          meta: `$${m.cost.toFixed(4)}`,
        })) ?? [],
    },
    {
      id: 'scoops',
      label: 'Scoops',
      count: scoops.length,
      rows: scoops.map((scoop) => {
        const label = scoop.isCone ? `${scoop.name || 'sliccy'} (cone)` : scoop.name;
        const processing = deps.isProcessing(scoop.jid);
        return { name: label, meta: processing ? 'processing' : 'idle', active: processing };
      }),
    },
    {
      id: 'processes',
      label: 'Processes',
      count: processes.length,
      rows: processes.map((proc) => {
        const shortArgv = proc.argv.length > 40 ? proc.argv.slice(0, 37) + '...' : proc.argv;
        const statusDot = proc.status === 'running';
        return { name: `${proc.pid}`, meta: shortArgv, active: statusDot };
      }),
    },
    {
      id: 'cron',
      label: 'Cron Tasks',
      count: cronTasks.length,
      rows: cronTasks.map((task) => ({
        name: task.name,
        meta: task.cron,
        active: task.status === 'active',
      })),
    },
    {
      id: 'webhooks',
      label: 'Webhooks',
      count: webhooks.length,
      rows: webhooks.map((wh) => ({
        name: wh.name,
        meta: wh.scoop ? `→ ${wh.scoop}` : '→ cone',
      })),
    },
    {
      id: 'workflows',
      label: 'Workflows',
      count: 0,
      rows: [],
    },
    {
      id: 'mounts',
      label: 'Mounts',
      count: mounts.length,
      rows: mounts.map((mount) => ({
        name: mount.targetPath,
        meta: mount.descriptor.kind,
      })),
    },
    {
      id: 'mcp',
      label: 'MCP Servers',
      count: mcpEntries.length,
      rows: mcpEntries.map(([name, entry]) => {
        const toolCount = entry.tools?.length ?? 0;
        return { name, meta: `${toolCount} tool${toolCount !== 1 ? 's' : ''}` };
      }),
    },
    {
      id: 'oauth',
      label: 'OAuth',
      count: oauthProviders.length,
      rows: oauthProviders.map((provider) => ({ name: provider, meta: '' })),
    },
  ];

  return sections;
}
