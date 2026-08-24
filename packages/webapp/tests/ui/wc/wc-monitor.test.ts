// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    getTrayInfo: () => ({ role: 'standalone', state: 'inactive' }),
    getConnectedFollowers: () => [],
    ...overrides,
  };
}

describe('fetchMonitorData', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns all eleven sections', async () => {
    const sections = await fetchMonitorData(makeDeps());
    expect(sections).toHaveLength(11);
  });

  it('shows standalone tray state and a clear followers empty state', async () => {
    const sections = await fetchMonitorData(makeDeps());
    const tray = sections.find((section) => section.id === 'tray')!;
    const followers = sections.find((section) => section.id === 'followers')!;

    expect(tray.rows[0]).toMatchObject({ name: 'Standalone', meta: 'inactive', status: 'idle' });
    expect(followers).toMatchObject({ count: 0, rows: [], accent: 'cyan' });
    expect(followers.emptyText).toContain('No followers connected yet');
  });

  it('shows exec and stalled followers with approved detail fields', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-03T10:10:00.000Z').getTime());
    const sections = await fetchMonitorData(
      makeDeps({
        getTrayInfo: () => ({
          role: 'leader',
          state: 'leader',
          joinUrl: 'https://tray.example/join/token',
          sessionId: 'tray-123456789',
          workerBaseUrl: 'https://tray.example',
        }),
        getConnectedFollowers: () => [
          {
            runtimeId: 'follower-cli-1',
            runtime: 'slicc-cli',
            connectedAt: '2026-08-03T10:00:00.000Z',
            floatType: 'unknown',
            health: 'live',
            peerState: 'connected',
            exec: true,
            motd: 'Remote build host',
          },
          {
            runtimeId: 'follower-browser-1',
            runtime: 'slicc-extension-offscreen',
            connectedAt: '2026-08-03T10:05:00.000Z',
            floatType: 'extension',
            hostOrigin: 'https://host.example',
            health: 'stalled',
            peerState: 'connected',
            cdp: true,
          },
        ],
      })
    );
    const tray = sections.find((section) => section.id === 'tray')!;
    const followers = sections.find((section) => section.id === 'followers')!;

    expect(tray.rows[0]).toMatchObject({ name: 'Leader', status: 'active' });
    expect(tray.rows[0].badges).toEqual(['join URL']);
    expect(followers.meta).toBe('1 connected · 1 stalled');
    expect(followers.rows[0]).toMatchObject({
      name: 'CLI · cli-1',
      sublabel: 'Remote build host',
      badges: ['ssh'],
      meta: 'connected 10m',
      status: 'active',
    });
    expect(followers.rows[1]).toMatchObject({
      name: 'Extension · browser-1',
      sublabel: 'slicc-extension-offscreen · https://host.example',
      badges: ['playwright'],
      meta: 'stalled 5m',
      status: 'warn',
    });
  });

  it('shows connecting followers as idle', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getConnectedFollowers: () => [
          {
            runtimeId: 'follower-ios-1',
            floatType: 'ios',
            health: 'live',
            peerState: 'connecting',
          },
        ],
      })
    );
    const followers = sections.find((section) => section.id === 'followers')!;
    expect(followers.count).toBe(0);
    expect(followers.meta).toBe('1 connecting');
    expect(followers.rows[0]).toMatchObject({
      name: 'iOS · ios-1',
      meta: 'connecting',
      status: 'idle',
    });
  });

  it('represents follower tray connection state without changing the follower placeholder', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getTrayInfo: () => ({
          role: 'follower',
          state: 'connected',
          joinUrl: 'https://tray.example/join/token',
          sessionId: 'tray-follower',
          workerBaseUrl: 'https://tray.example',
        }),
      })
    );
    const tray = sections.find((section) => section.id === 'tray')!;
    expect(tray.meta).toBe('follower · connected');
    expect(tray.rows[0]).toMatchObject({ name: 'Follower', meta: 'connected', status: 'active' });
  });

  it('shows scoop rows with status', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getScoops: () => [
          { jid: 'cone-1', name: 'sliccy', parentJid: null } as any,
          { jid: 's-1', name: 'researcher', parentJid: 'cone-1' } as any,
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

  it('shows empty resource sections with count 0', async () => {
    const sections = await fetchMonitorData(makeDeps());
    for (const section of sections.filter((section) => section.id !== 'tray')) {
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

  it('shows a green dot for a local mount with confirmed permission (valid: true)', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getMounts: async () => [
          {
            targetPath: '/mnt/okrs',
            descriptor: { kind: 'local', mountId: 'm1', idbHandleKey: 'k' },
            createdAt: 0,
            valid: true,
          },
        ],
      })
    );
    const mountSection = sections.find((s) => s.id === 'mounts')!;
    expect(mountSection.rows[0].active).toBe(true);
    expect(mountSection.rows[0].error).toBe(false);
  });

  it('shows a red dot for a local mount that has lost permission (valid: false)', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getMounts: async () => [
          {
            targetPath: '/mnt/okrs',
            descriptor: { kind: 'local', mountId: 'm1', idbHandleKey: 'k' },
            createdAt: 0,
            valid: false,
          },
        ],
      })
    );
    const mountSection = sections.find((s) => s.id === 'mounts')!;
    expect(mountSection.rows[0].active).toBe(false);
    expect(mountSection.rows[0].error).toBe(true);
  });

  it('shows the default (neither active nor error) dot for a remote mount, where `valid` is never set', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getMounts: async () => [
          {
            targetPath: '/mnt/da-okrs',
            descriptor: { kind: 'da', mountId: 'm2', source: 'da://org/repo', profile: 'default' },
            createdAt: 0,
            // no `valid` field — remote backends don't have a live
            // permission concept the monitor can check (see mount-recovery.ts)
          },
        ],
      })
    );
    const mountSection = sections.find((s) => s.id === 'mounts')!;
    expect(mountSection.rows[0].active).toBe(false);
    expect(mountSection.rows[0].error).toBe(false);
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
        getOAuthProviders: () => [{ providerId: 'adobe' }, { providerId: 'github' }],
      })
    );
    const oauthSection = sections.find((s) => s.id === 'oauth')!;
    expect(oauthSection.count).toBe(2);
    expect(oauthSection.rows[0].name).toBe('adobe');
  });

  it('shows a green dot for a valid OAuth account', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getOAuthProviders: () => [{ providerId: 'adobe', valid: true }],
      })
    );
    const oauthSection = sections.find((s) => s.id === 'oauth')!;
    expect(oauthSection.rows[0].active).toBe(true);
    expect(oauthSection.rows[0].error).toBe(false);
  });

  it('shows a red dot for an expired/logged-out OAuth account', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getOAuthProviders: () => [{ providerId: 'adobe', valid: false }],
      })
    );
    const oauthSection = sections.find((s) => s.id === 'oauth')!;
    expect(oauthSection.rows[0].active).toBe(false);
    expect(oauthSection.rows[0].error).toBe(true);
  });

  it('shows the default/neutral dot for a non-OAuth (API-key) account', async () => {
    const sections = await fetchMonitorData(
      makeDeps({
        getOAuthProviders: () => [{ providerId: 'anthropic' }],
      })
    );
    const oauthSection = sections.find((s) => s.id === 'oauth')!;
    expect(oauthSection.rows[0].active).toBe(false);
    expect(oauthSection.rows[0].error).toBe(false);
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
