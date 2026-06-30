// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { fetchMonitorData, type MonitorDeps } from '../../../src/ui/wc/wc-monitor.js';

function makeDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    getScoops: () => [],
    isProcessing: () => false,
    getCronTasks: async () => [],
    getWebhooks: async () => [],
    getMounts: async () => [],
    getMcpServers: async () => ({}),
    getOAuthProviders: () => [],
    getSessionStats: async () => null,
    getProcesses: async () => [],
    ...overrides,
  };
}

describe('fetchMonitorData', () => {
  it('returns all nine sections', async () => {
    const sections = await fetchMonitorData(makeDeps());
    expect(sections).toHaveLength(9);
  });

  it('shows scoop rows with status', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getScoops: () => [
          { jid: 'cone-1', name: 'sliccy', isCone: true } as any,
          { jid: 's-1', name: 'researcher', isCone: false } as any,
        ],
        isProcessing: (jid) => jid === 'cone-1',
      })
    );
    const scoopSection = sections.find((s) => s.id === 'scoops')!;
    expect(scoopSection.count).toBe(2);
    expect(scoopSection.rows).toHaveLength(2);
    expect(scoopSection.rows[0].name).toBe('sliccy (cone)');
    expect(scoopSection.rows[0].active).toBe(true);
  });

  it('shows cron task rows with schedule', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getCronTasks: async () => [
          {
            id: 'c1',
            name: 'daily-check',
            cron: '0 9 * * *',
            scoop: 'researcher',
            status: 'active',
            nextRun: null,
            lastRun: null,
            createdAt: '',
          },
        ],
      })
    );
    const cronSection = sections.find((s) => s.id === 'cron')!;
    expect(cronSection.count).toBe(1);
    expect(cronSection.rows[0].name).toBe('daily-check');
    expect(cronSection.rows[0].meta).toContain('0 9 * * *');
  });

  it('shows empty sections with count 0', async () => {
    const sections = await fetchMonitorData(makeDeps());
    for (const section of sections) {
      expect(section.count).toBe(0);
    }
  });

  it('shows webhook rows', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getWebhooks: async () => [{ id: 'w1', name: 'gh-push', createdAt: '', scoop: 'cone' }],
      })
    );
    const webhookSection = sections.find((s) => s.id === 'webhooks')!;
    expect(webhookSection.count).toBe(1);
    expect(webhookSection.rows[0].name).toBe('gh-push');
  });

  it('shows mount rows with kind', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getMounts: async () => [
          {
            targetPath: '/workspace/proj',
            descriptor: { kind: 'local', mountId: 'm1', idbHandleKey: 'k' },
            createdAt: 0,
          },
        ],
      })
    );
    const mountSection = sections.find((s) => s.id === 'mounts')!;
    expect(mountSection.count).toBe(1);
    expect(mountSection.rows[0].name).toBe('/workspace/proj');
    expect(mountSection.rows[0].meta).toBe('local');
  });

  it('shows MCP server rows with tool count', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getMcpServers: async () => ({
          github: { url: 'https://github.mcp', tools: [{}, {}, {}] } as any,
        }),
      })
    );
    const mcpSection = sections.find((s) => s.id === 'mcp')!;
    expect(mcpSection.count).toBe(1);
    expect(mcpSection.rows[0].name).toBe('github');
    expect(mcpSection.rows[0].meta).toBe('3 tools');
  });

  it('shows OAuth provider rows', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getOAuthProviders: () => ['adobe', 'github'],
      })
    );
    const oauthSection = sections.find((s) => s.id === 'oauth')!;
    expect(oauthSection.count).toBe(2);
    expect(oauthSection.rows[0].name).toBe('adobe');
  });

  it('shows cost section with model breakdown', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getSessionStats: async () => ({
          totalCost: 1.23,
          models: [
            { model: 'claude-opus-4-6', cost: 0.85 },
            { model: 'claude-sonnet-4-6', cost: 0.38 },
          ],
          scoops: [],
        }),
      })
    );
    const costSection = sections.find((s) => s.id === 'cost')!;
    expect(costSection.meta).toBe('$1.23');
    expect(costSection.rows).toHaveLength(2);
    expect(costSection.rows[0].name).toBe('claude-opus-4-6');
    expect(costSection.rows[0].meta).toBe('$0.8500');
  });

  it('shows processes section with pid and argv', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getProcesses: async () => [
          { pid: 1024, argv: 'node script.js', status: 'running' },
          {
            pid: 1025,
            argv: 'python3 -c "print(1234567890123456789012345678901234567890)"',
            status: 'sleeping',
          },
        ],
      })
    );
    const processSection = sections.find((s) => s.id === 'processes')!;
    expect(processSection.rows).toHaveLength(2);
    expect(processSection.rows[0].name).toBe('1024');
    expect(processSection.rows[0].meta).toBe('node script.js');
    expect(processSection.rows[0].active).toBe(true);
    expect(processSection.rows[1].meta).toContain('...');
  });
});
