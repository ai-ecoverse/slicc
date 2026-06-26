// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { buildMonitorSections, type MonitorDeps } from '../../../src/ui/wc/wc-monitor.js';

function makeDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    getScoops: () => [],
    isProcessing: () => false,
    getCronTasks: async () => [],
    getWebhooks: async () => [],
    getMounts: async () => [],
    getMcpServers: async () => ({}),
    getOAuthProviders: () => [],
    ...overrides,
  };
}

describe('buildMonitorSections', () => {
  it('renders all seven section headers', async () => {
    const root = await buildMonitorSections(makeDeps());
    const headers = root.querySelectorAll('.monitor-section__header');
    expect(headers).toHaveLength(7);
  });

  it('shows scoop rows with status', async () => {
    const root = await buildMonitorSections(
      makeDeps({
        getScoops: () => [
          { jid: 'cone-1', name: 'sliccy', isCone: true } as any,
          { jid: 's-1', name: 'researcher', isCone: false } as any,
        ],
        isProcessing: (jid) => jid === 'cone-1',
      })
    );
    const scoopRows = root.querySelectorAll('[data-section="scoops"] .monitor-row');
    expect(scoopRows).toHaveLength(2);
    expect(scoopRows[0].querySelector('.monitor-row__name')!.textContent).toBe('sliccy (cone)');
    expect(scoopRows[0].querySelector('.monitor-row__dot--active')).not.toBeNull();
  });

  it('shows cron task rows with schedule', async () => {
    const root = await buildMonitorSections(
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
    const cronRows = root.querySelectorAll('[data-section="cron"] .monitor-row');
    expect(cronRows).toHaveLength(1);
    expect(cronRows[0].querySelector('.monitor-row__name')!.textContent).toBe('daily-check');
    expect(cronRows[0].querySelector('.monitor-row__meta')!.textContent).toContain('0 9 * * *');
  });

  it('shows empty sections with count 0', async () => {
    const root = await buildMonitorSections(makeDeps());
    const counts = root.querySelectorAll('.monitor-section__count');
    for (const count of counts) {
      expect(count.textContent).toBe('0');
    }
  });

  it('shows webhook rows', async () => {
    const root = await buildMonitorSections(
      makeDeps({
        getWebhooks: async () => [{ id: 'w1', name: 'gh-push', createdAt: '', scoop: 'cone' }],
      })
    );
    const rows = root.querySelectorAll('[data-section="webhooks"] .monitor-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.monitor-row__name')!.textContent).toBe('gh-push');
  });

  it('shows mount rows with kind', async () => {
    const root = await buildMonitorSections(
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
    const rows = root.querySelectorAll('[data-section="mounts"] .monitor-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.monitor-row__name')!.textContent).toBe('/workspace/proj');
    expect(rows[0].querySelector('.monitor-row__meta')!.textContent).toBe('local');
  });

  it('shows MCP server rows with tool count', async () => {
    const root = await buildMonitorSections(
      makeDeps({
        getMcpServers: async () => ({
          github: { url: 'https://github.mcp', tools: [{}, {}, {}] } as any,
        }),
      })
    );
    const rows = root.querySelectorAll('[data-section="mcp"] .monitor-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.monitor-row__name')!.textContent).toBe('github');
    expect(rows[0].querySelector('.monitor-row__meta')!.textContent).toBe('3 tools');
  });

  it('shows OAuth provider rows', async () => {
    const root = await buildMonitorSections(
      makeDeps({
        getOAuthProviders: () => ['adobe', 'github'],
      })
    );
    const rows = root.querySelectorAll('[data-section="oauth"] .monitor-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.monitor-row__name')!.textContent).toBe('adobe');
  });

  it('persists collapse state', async () => {
    localStorage.setItem('slicc_monitor_collapsed', JSON.stringify(['webhooks']));
    const root = await buildMonitorSections(makeDeps());
    const webhookSection = root.querySelector('[data-section="webhooks"]')!;
    expect(
      webhookSection.querySelector('.monitor-section__body')!.getAttribute('hidden')
    ).not.toBeNull();
    localStorage.removeItem('slicc_monitor_collapsed');
  });
});
