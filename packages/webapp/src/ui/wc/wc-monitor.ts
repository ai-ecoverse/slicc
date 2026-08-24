/**
 * Monitor surface for the WC workbench: read-only dashboard of all resources
 * managed by SLICC — tray connections, followers, scoops, cron tasks,
 * webhooks, mounts, MCP servers, and OAuth accounts.
 */

import type { MonitorSection } from '@slicc/webcomponents';
import type { MountTableEntry } from '../../fs/mount-table-store.js';
import type { CronTaskEntry, WebhookEntry } from '../../scoops/lick-manager.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import type { ConnectedFollowerInfo } from '../../shell/supplemental-commands/host-command.js';
import { isRootUnit } from '../../work-unit/policy.js';
import {
  followerIcon,
  followerMeta,
  followerStatus,
  followerTitle,
  shortFollowerId,
} from '../follower-presentation.js';

/**
 * A persisted mount entry, augmented with the permission state as of the
 * moment this monitor render was fetched — checked fresh on every
 * `fetchMonitorData` call (initial load, the 5s auto-refresh, and manual
 * "↻ Refresh" clicks), never polled independently. `valid` is `true` for a
 * local mount whose handle still reports `queryPermission → 'granted'`,
 * `false` for a local mount that needs recovery, and `undefined` for
 * remote mounts (s3/da/proc) — those backends don't hold this kind of
 * live client-side permission state (see mount-recovery.ts's doc comment),
 * so they intentionally get the default/neutral dot rather than a
 * false green or red.
 */
type MountMonitorRow = MountTableEntry & { valid?: boolean };

/**
 * One OAuth-backed provider account as reported to the monitor. `valid` is
 * derived entirely from locally-held account metadata (`loggedOut`,
 * `tokenExpiresAt`) — no token is read for its value and no network call is
 * made to check it:
 *   - `true`  — has a token and it isn't past `tokenExpiresAt` (or the
 *     provider doesn't report an expiry at all).
 *   - `false` — explicitly logged out, or the stored token is past its
 *     `tokenExpiresAt`.
 *   - `undefined` — not an OAuth provider (plain API-key account), so this
 *     status concept doesn't apply; renders the neutral/default dot.
 */
export interface OAuthProviderEntry {
  providerId: string;
  valid?: boolean;
}

/** One live process row, already narrowed to what the monitor renders. */
export interface MonitorProcess {
  pid: number;
  argv: string;
  status: string;
}

/**
 * What the monitor knows about the process table.
 *
 * `processes` is LIVE processes only. `terminated` is the session total of
 * everything that has already exited — a number the kernel keeps counting
 * past its own retention window, so it stays true without the dead rows
 * having to stay resident (or rendered) to prove it.
 */
export interface MonitorProcessSnapshot {
  processes: MonitorProcess[];
  terminated: number;
}

export interface MonitorTrayInfo {
  role: 'leader' | 'follower' | 'standalone';
  state: 'inactive' | 'connecting' | 'connected' | 'leader' | 'reconnecting' | 'error';
  joinUrl?: string | null;
  sessionId?: string | null;
  workerBaseUrl?: string | null;
  stalled?: boolean;
}

export interface MonitorDeps {
  getScoops(): RegisteredScoop[];
  isProcessing(jid: string): boolean;
  getCronTasks(): Promise<CronTaskEntry[]>;
  getWebhooks(): Promise<WebhookEntry[]>;
  getMounts(): Promise<MountMonitorRow[]>;
  getMcpServers(): Promise<Record<string, { url: string; tools?: unknown[] }>>;
  getOAuthProviders(): OAuthProviderEntry[];
  getSessionStats(): Promise<{
    totalCost: number;
    models: { model: string; cost: number }[];
    scoops: { name: string; cost: number }[];
  } | null>;
  getProcesses(): Promise<MonitorProcessSnapshot>;
  getTrayInfo(): MonitorTrayInfo;
  getConnectedFollowers(): ConnectedFollowerInfo[];
}

export function buildFollowersSection(followers: ConnectedFollowerInfo[]): MonitorSection {
  const stalled = followers.filter((follower) => follower.health === 'stalled').length;
  const connecting = followers.filter(
    (follower) => follower.health !== 'stalled' && follower.peerState === 'connecting'
  ).length;
  const connected = followers.length - stalled - connecting;
  const summary = [
    connected > 0 ? `${connected} connected` : '',
    connecting > 0 ? `${connecting} connecting` : '',
    stalled > 0 ? `${stalled} stalled` : '',
  ].filter(Boolean);
  return {
    id: 'followers',
    label: 'Followers',
    count: followers.filter((follower) => follower.peerState === 'connected').length,
    meta: summary.join(' · ') || undefined,
    accent: 'cyan',
    emptyText: 'No followers connected yet. Pair a phone, tablet, or CLI follower to this tray.',
    rows: followers.map((follower) => {
      const detail = follower.motd ?? follower.runtime ?? 'Connected follower';
      const sublabel = follower.hostOrigin ? `${detail} · ${follower.hostOrigin}` : detail;
      const badges = [follower.exec ? 'ssh' : '', follower.cdp ? 'playwright' : ''].filter(Boolean);
      return {
        name: followerTitle(follower),
        sublabel,
        meta: followerMeta(follower),
        icon: followerIcon(follower),
        badges,
        status: followerStatus(follower),
      };
    }),
  };
}

function buildTraySection(tray: MonitorTrayInfo): MonitorSection {
  const state = tray.stalled ? 'stalled' : tray.state === 'leader' ? 'connected' : tray.state;
  const status =
    tray.stalled || tray.state === 'reconnecting'
      ? 'warn'
      : tray.state === 'error'
        ? 'error'
        : tray.state === 'leader' || tray.state === 'connected'
          ? 'active'
          : 'idle';
  const session = tray.sessionId ? `Session ${shortFollowerId(tray.sessionId)}` : null;
  const worker = tray.workerBaseUrl ? `Worker · ${tray.workerBaseUrl}` : null;
  return {
    id: 'tray',
    label: 'Tray',
    count: 1,
    meta: `${tray.role} · ${state}`,
    accent: 'waffle',
    rows: [
      {
        name: tray.role[0].toUpperCase() + tray.role.slice(1),
        sublabel: [session, worker].filter(Boolean).join(' · ') || 'No tray session',
        meta: state,
        icon: tray.role === 'follower' ? 'radio' : 'cloud',
        badges: tray.joinUrl ? ['join URL'] : [],
        status,
      },
    ],
  };
}

/**
 * Fetch monitor data and return it as `MonitorSection[]` for the
 * `<slicc-monitor>` component.
 */
export async function fetchMonitorData(deps: MonitorDeps): Promise<MonitorSection[]> {
  const scoops = deps.getScoops();
  const tray = deps.getTrayInfo();
  const followers = deps.getConnectedFollowers();
  const [cronTasks, webhooks, mounts, mcpServers, sessionStats, procSnapshot] = await Promise.all([
    deps.getCronTasks().catch(() => [] as CronTaskEntry[]),
    deps.getWebhooks().catch(() => [] as WebhookEntry[]),
    deps.getMounts().catch(() => [] as MountMonitorRow[]),
    deps.getMcpServers().catch(() => ({}) as Record<string, { url: string; tools?: unknown[] }>),
    deps.getSessionStats().catch(() => null),
    deps.getProcesses().catch(() => ({ processes: [], terminated: 0 })),
  ]);
  const { processes, terminated } = procSnapshot;
  const oauthProviders = deps.getOAuthProviders();
  const mcpEntries = Object.entries(mcpServers);

  const sections: MonitorSection[] = [
    buildTraySection(tray),
    buildFollowersSection(followers),
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
        const label = isRootUnit(scoop) ? `${scoop.name || 'sliccy'} (cone)` : scoop.name;
        const processing = deps.isProcessing(scoop.jid);
        return { name: label, meta: processing ? 'processing' : 'idle', active: processing };
      }),
    },
    {
      id: 'processes',
      // Live processes only — the same default `ps` has ("listing them by
      // default is noisy", ps-command.ts). Exited processes are reported as
      // a count in `meta`, never as rows: a long session terminates
      // thousands of them, and a list of dead pids is not something anyone
      // reads. The count comes from the kernel's session total, so it stays
      // right even after those records are reaped.
      label: 'Processes',
      count: processes.length,
      meta:
        terminated > 0
          ? `${processes.length} live · ${terminated.toLocaleString()} exited`
          : undefined,
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
        // valid === true  → green (permission confirmed as of this render)
        // valid === false → red (needs recovery as of this render)
        // valid === undefined (remote backends) → default grey, no check made
        active: mount.valid === true,
        error: mount.valid === false,
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
      rows: oauthProviders.map((provider) => ({
        name: provider.providerId,
        meta: '',
        // valid === true  → green (has a token, not past its expiry)
        // valid === false → red (logged out, or token past its expiry)
        // valid === undefined (non-OAuth / API-key account) → default grey
        active: provider.valid === true,
        error: provider.valid === false,
      })),
    },
  ];

  return sections;
}
