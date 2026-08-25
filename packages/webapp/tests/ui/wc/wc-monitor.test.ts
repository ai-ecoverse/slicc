// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { MonitorSection } from '@slicc/webcomponents';
import { MonitorHistory } from '../../../src/ui/wc/monitor-history.js';
import {
  buildAlerts,
  buildVitals,
  fetchMonitorData,
  type MonitorDeps,
} from '../../../src/ui/wc/wc-monitor.js';

/** The topology groups alone — most assertions here are about those. */
async function fetchSections(deps: MonitorDeps): Promise<MonitorSection[]> {
  return (await fetchMonitorData(deps)).sections ?? [];
}

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
    getProcesses: async () => ({ processes: [], terminated: 0 }),
    getTrayInfo: () => ({ role: 'standalone', state: 'inactive' }),
    getConnectedFollowers: () => [],
    ...overrides,
  };
}

describe('fetchMonitorData', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns seven topology groups, not eleven cards', async () => {
    const sections = await fetchSections(makeDeps());
    expect(sections.map((section) => section.id)).toEqual([
      'tray',
      'followers',
      'scoops',
      'mounts',
      'integrations',
      'automations',
      'cost',
    ]);
  });

  it('shows standalone tray state and a clear followers empty state', async () => {
    const sections = await fetchSections(makeDeps());
    const tray = sections.find((section) => section.id === 'tray')!;
    const followers = sections.find((section) => section.id === 'followers')!;

    expect(tray.rows[0]).toMatchObject({ name: 'Standalone', meta: 'inactive', status: 'idle' });
    expect(followers).toMatchObject({ count: 0, rows: [], accent: 'cyan' });
    expect(followers.emptyText).toContain('No followers connected yet');
  });

  it('shows exec and stalled followers with approved detail fields', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-03T10:10:00.000Z').getTime());
    const sections = await fetchSections(
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
    const sections = await fetchSections(
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
    const sections = await fetchSections(
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
    const sections = await fetchSections(
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
    const sections = await fetchSections(
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
    const automations = sections.find((s) => s.id === 'automations')!;
    expect(automations.count).toBe(1);
    expect(automations.meta).toBe('0 webhooks · 1 cron task');
    expect(automations.rows[0].name).toBe('daily-check');
    expect(automations.rows[0].meta).toContain('0 9 * * *');
  });

  it('shows empty resource sections with count 0', async () => {
    const sections = await fetchSections(makeDeps());
    for (const section of sections.filter((section) => section.id !== 'tray')) {
      expect(section.count).toBe(0);
    }
  });

  it('shows webhook rows', async () => {
    const sections = await fetchSections(
      makeDeps({
        getWebhooks: async () => [{ id: 'w1', name: 'gh-push', createdAt: '', scoop: 'cone' }],
      })
    );
    const automations = sections.find((s) => s.id === 'automations')!;
    expect(automations.count).toBe(1);
    expect(automations.meta).toBe('1 webhook · no cron tasks');
    expect(automations.rows[0].name).toBe('gh-push');
  });

  it('shows mount rows with kind', async () => {
    const sections = await fetchSections(
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
    const sections = await fetchSections(
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
    expect(mountSection.rows[0].status).toBe('active');
    expect(mountSection.meta).toBe('1 · all granted');
  });

  it('shows a red dot for a local mount that has lost permission (valid: false)', async () => {
    const sections = await fetchSections(
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
    expect(mountSection.rows[0].status).toBe('warn');
    expect(mountSection.rows[0].meta).toBe('permission lost');
    // The group rolls up to attention, which is what auto-expands it.
    expect(mountSection.status).toBe('warn');
    expect(mountSection.meta).toBe('1 · 1 needs re-grant');
  });

  it('shows the default (neither active nor error) dot for a remote mount, where `valid` is never set', async () => {
    const sections = await fetchSections(
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
    expect(mountSection.rows[0].status).toBe('idle');
    expect(mountSection.status).toBe('active');
  });

  it('shows MCP server rows with tool count', async () => {
    const sections = await fetchSections(
      makeDeps({
        getMcpServers: async () => ({
          github: { url: 'https://github.mcp', tools: [{}, {}, {}] } as any,
        }),
      })
    );
    const integrations = sections.find((s) => s.id === 'integrations')!;
    expect(integrations.count).toBe(1);
    expect(integrations.meta).toBe('1 server · 3 tools · 0 accounts valid');
    expect(integrations.rows[0].name).toBe('github');
    expect(integrations.rows[0].meta).toBe('MCP · 3 tools');
  });

  it('shows OAuth provider rows', async () => {
    const sections = await fetchSections(
      makeDeps({
        getOAuthProviders: () => [{ providerId: 'adobe' }, { providerId: 'github' }],
      })
    );
    const integrations = sections.find((s) => s.id === 'integrations')!;
    expect(integrations.count).toBe(2);
    expect(integrations.rows.map((row) => row.name)).toEqual(['adobe', 'github']);
  });

  it('shows a green dot for a valid OAuth account', async () => {
    const sections = await fetchSections(
      makeDeps({
        getOAuthProviders: () => [{ providerId: 'adobe', valid: true }],
      })
    );
    const integrations = sections.find((s) => s.id === 'integrations')!;
    expect(integrations.rows[0].status).toBe('active');
    expect(integrations.status).toBe('active');
  });

  it('shows a red dot for an expired/logged-out OAuth account', async () => {
    const sections = await fetchSections(
      makeDeps({
        getOAuthProviders: () => [{ providerId: 'adobe', valid: false }],
      })
    );
    const integrations = sections.find((s) => s.id === 'integrations')!;
    expect(integrations.rows[0].status).toBe('error');
    expect(integrations.rows[0].meta).toBe('session expired');
    expect(integrations.status).toBe('error');
    expect(integrations.meta).toContain('1 account expired');
  });

  it('shows the default/neutral dot for a non-OAuth (API-key) account', async () => {
    const sections = await fetchSections(
      makeDeps({
        getOAuthProviders: () => [{ providerId: 'anthropic' }],
      })
    );
    const integrations = sections.find((s) => s.id === 'integrations')!;
    expect(integrations.rows[0].status).toBe('idle');
    expect(integrations.status).toBe('active');
  });

  it('shows cost section with model breakdown', async () => {
    const sections = await fetchSections(
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
    expect(costSection.meta).toBe('$1.23 across 2 models');
    expect(costSection.rows).toHaveLength(2);
    expect(costSection.rows[0].name).toBe('claude-opus-4-6');
    expect(costSection.rows[0].meta).toBe('$0.8500');
  });

  it('renders live processes as a real table, with ps column vocabulary', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-24T18:13:00.000Z').getTime());
    const model = await fetchMonitorData(
      makeDeps({
        getProcesses: async () => ({
          processes: [
            {
              pid: 1024,
              ppid: 1,
              argv: 'node script.js',
              status: 'running',
              scoop: 'cone',
              startedAt: new Date('2026-08-24T18:01:00.000Z').getTime(),
            },
            { pid: 1025, argv: 'rg --json MonitorSection', status: 'pending' },
          ],
          terminated: 0,
        }),
      })
    );
    expect(model.processes?.rows).toHaveLength(2);
    expect(model.processes?.rows[0]).toMatchObject({
      pid: 1024,
      ppid: 1,
      state: 'R',
      status: 'running',
      command: 'node script.js',
      scoop: 'cone',
      elapsed: '12m 0s',
    });
    // The command is NOT truncated here: the table gives it a full column and
    // ellipsizes in CSS, so the model must not pre-cut it to 40 characters.
    expect(model.processes?.rows[1].command).toBe('rg --json MonitorSection');
    expect(model.processes?.rows[1].state).toBe('S');
  });

  it('reports exited processes as a count, never as rows', async () => {
    const model = await fetchMonitorData(
      makeDeps({
        getProcesses: async () => ({
          processes: [{ pid: 1024, argv: 'node script.js', status: 'running' }],
          terminated: 1435,
        }),
      })
    );
    expect(model.processes?.rows).toHaveLength(1);
    expect(model.processes?.terminated).toBe(1435);
    expect(model.sections?.some((section) => section.id === 'processes')).toBe(false);
  });

  it('degrades to an empty table when the process read fails', async () => {
    const model = await fetchMonitorData(
      makeDeps({
        getProcesses: async () => {
          throw new Error('proc mount unavailable');
        },
      })
    );
    expect(model.processes).toEqual({ rows: [], terminated: 0 });
  });
});

describe('buildVitals', () => {
  const base = {
    stats: null,
    workingUnits: 0,
    totalUnits: 0,
    liveProcesses: 0,
    terminated: 0,
  };

  it('leads with the burn RATE, not a count of tracked things', async () => {
    const model = await fetchMonitorData(
      makeDeps({
        getSessionStats: async () => ({
          totalCost: 29.06,
          burnRate: 1.4,
          models: [],
          scoops: [],
        }),
      })
    );
    const hero = model.vitals?.find((vital) => vital.hero);
    expect(hero).toMatchObject({ id: 'burn', value: '$1.40', unit: '/hour' });
    expect(hero?.foot).toContain('$29.06 this session');
    // Exactly one hero — the ≥48px figure only works if it is unique.
    expect(model.vitals?.filter((vital) => vital.hero)).toHaveLength(1);
  });

  it('reads $0.00 rather than blank when no stats have landed yet', () => {
    const [hero] = buildVitals(base);
    expect(hero.value).toBe('$0.00');
    expect(hero.foot).toBe('no spend yet');
  });

  it('drops the decimals on an implausibly large rate rather than overflowing the tile', () => {
    const [hero] = buildVitals({
      ...base,
      stats: { totalCost: 0, burnRate: 1234.5, models: [], scoops: [] },
    });
    expect(hero.value).toBe('$1235');
  });

  it('omits the context meter when there is no fill reading to show', () => {
    const vitals = buildVitals(base);
    expect(vitals.find((vital) => vital.id === 'context')).toBeUndefined();
  });

  it('meters the FULLEST context window, and escalates its accent', () => {
    const withFills = (fill: number) =>
      buildVitals({
        ...base,
        stats: {
          totalCost: 0,
          models: [],
          scoops: [],
          fills: [
            { jid: 'a', fill: 0.1 },
            { jid: 'b', fill },
          ],
        },
      }).find((vital) => vital.id === 'context');

    expect(withFills(0.42)).toMatchObject({ value: '42', ratio: 0.42, accent: 'green' });
    expect(withFills(0.75)?.accent).toBe('amber');
    expect(withFills(0.95)?.accent).toBe('rose');
  });

  it('carries no series until the history has two points to plot', () => {
    const history = new MonitorHistory();
    expect(buildVitals({ ...base, history })[0].series).toBeUndefined();
    history.push({ at: 1_000, burnRate: 1, workingUnits: 0, liveProcesses: 2 });
    expect(buildVitals({ ...base, history })[0].series).toBeUndefined();
    history.push({ at: 6_000, burnRate: 2, workingUnits: 1, liveProcesses: 3 });
    expect(buildVitals({ ...base, history })[0].series?.points).toEqual([
      { at: 1_000, value: 1 },
      { at: 6_000, value: 2 },
    ]);
  });
});

describe('buildAlerts', () => {
  const tray = { role: 'standalone', state: 'inactive' } as const;
  const base = { tray, followers: [], mounts: [], oauthProviders: [] };

  it('is empty on a healthy system', () => {
    expect(buildAlerts(base)).toEqual([]);
  });

  it('names an expired account, and sorts errors above warnings', () => {
    const alerts = buildAlerts({
      ...base,
      oauthProviders: [{ providerId: 'github', valid: false }],
      mounts: [
        {
          targetPath: '/mnt/photos',
          descriptor: { kind: 'local', mountId: 'm1', idbHandleKey: 'k' },
          createdAt: 0,
          valid: false,
        },
      ],
    });
    expect(alerts.map((alert) => alert.severity)).toEqual(['error', 'warn']);
    expect(alerts[0].title).toBe('github session expired');
    expect(alerts[1].title).toBe('/mnt/photos needs re-grant');
  });

  it('raises a stalled follower but not a healthy one', () => {
    const alerts = buildAlerts({
      ...base,
      followers: [
        { runtimeId: 'a', health: 'live', peerState: 'connected' },
        { runtimeId: 'b', health: 'stalled', peerState: 'connected', motd: 'QA iPad' },
      ],
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: 'follower:b', severity: 'warn', detail: 'QA iPad' });
  });

  it('raises a reconnecting tray as a warning and a failed one as an error', () => {
    expect(
      buildAlerts({ ...base, tray: { role: 'leader', state: 'reconnecting' } })[0]
    ).toMatchObject({
      id: 'tray',
      severity: 'warn',
    });
    expect(buildAlerts({ ...base, tray: { role: 'leader', state: 'error' } })[0].severity).toBe(
      'error'
    );
  });

  it('does not raise a valid account or a granted mount', () => {
    const alerts = buildAlerts({
      ...base,
      oauthProviders: [{ providerId: 'anthropic', valid: true }, { providerId: 'xai' }],
      mounts: [
        {
          targetPath: '/mnt/ok',
          descriptor: { kind: 'local', mountId: 'm1', idbHandleKey: 'k' },
          createdAt: 0,
          valid: true,
        },
      ],
    });
    expect(alerts).toEqual([]);
  });
});
