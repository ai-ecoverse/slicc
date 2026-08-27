/**
 * Monitor surface for the WC workbench.
 *
 * Builds the `<slicc-monitor>` model out of everything SLICC manages. The
 * shape of that model is the design: vitals (rates and ratios over time),
 * an attention feed (what is degraded), topology (named things, healthy ones
 * collapsed to a line), and the process table. See the component doc for why
 * those are four different vocabularies rather than one repeated card.
 */

import type {
  MonitorAlert,
  MonitorMeterMarker,
  MonitorModel,
  MonitorProcessRow,
  MonitorSection,
  MonitorStatus,
  MonitorVital,
} from '@slicc/webcomponents';
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
import type { MonitorHistory } from './monitor-history.js';
import { scoopColor } from './wc-scoop-color.js';

/**
 * A persisted mount entry, augmented with the permission state as of the
 * moment this monitor render was fetched — checked fresh on every
 * `fetchMonitorData` call (initial load, the 5s auto-refresh, and manual
 * "↻ Re-sync" clicks), never polled independently. `valid` is `true` for a
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
  ppid?: number;
  argv: string;
  status: string;
  scoop?: string;
  startedAt?: number;
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

/** The subset of the worker's `SessionStats` the monitor reads. */
export interface MonitorSessionStats {
  totalCost: number;
  burnRate?: number;
  models: { model: string; cost: number }[];
  scoops: { name: string; cost: number }[];
  fills?: { jid: string; fill: number }[];
}

export interface MonitorDeps {
  getScoops(): RegisteredScoop[];
  isProcessing(jid: string): boolean;
  getCronTasks(): Promise<CronTaskEntry[]>;
  getWebhooks(): Promise<WebhookEntry[]>;
  getMounts(): Promise<MountMonitorRow[]>;
  getMcpServers(): Promise<Record<string, { url: string; tools?: unknown[] }>>;
  getOAuthProviders(): OAuthProviderEntry[];
  getSessionStats(): Promise<MonitorSessionStats | null>;
  getProcesses(): Promise<MonitorProcessSnapshot>;
  getTrayInfo(): MonitorTrayInfo;
  getConnectedFollowers(): ConnectedFollowerInfo[];
}

// ---------------------------------------------------------------------------
// Topology groups
// ---------------------------------------------------------------------------

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
    icon: 'radio',
    count: followers.filter((follower) => follower.peerState === 'connected').length,
    meta: summary.join(' · ') || 'none paired',
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

function trayStatus(tray: MonitorTrayInfo): MonitorStatus {
  if (tray.stalled || tray.state === 'reconnecting') return 'warn';
  if (tray.state === 'error') return 'error';
  if (tray.state === 'leader' || tray.state === 'connected') return 'active';
  return 'idle';
}

function trayStateLabel(tray: MonitorTrayInfo): string {
  if (tray.stalled) return 'stalled';
  return tray.state === 'leader' ? 'connected' : tray.state;
}

function buildTraySection(tray: MonitorTrayInfo): MonitorSection {
  const state = trayStateLabel(tray);
  const session = tray.sessionId ? `Session ${shortFollowerId(tray.sessionId)}` : null;
  const worker = tray.workerBaseUrl ? `Worker · ${tray.workerBaseUrl}` : null;
  return {
    id: 'tray',
    label: 'Tray',
    icon: tray.role === 'follower' ? 'radio' : 'cloud',
    count: 1,
    meta: `${tray.role} · ${state}`,
    accent: 'waffle',
    status: trayStatus(tray),
    rows: [
      {
        name: tray.role[0].toUpperCase() + tray.role.slice(1),
        sublabel: [session, worker].filter(Boolean).join(' · ') || 'No tray session',
        meta: state,
        icon: tray.role === 'follower' ? 'radio' : 'cloud',
        badges: tray.joinUrl ? ['join URL'] : [],
        status: trayStatus(tray),
      },
    ],
  };
}

/**
 * Scoops as a two-level tree rather than a flat list: the cone → scoop
 * hierarchy is real, and `parentJid` already records it, so flattening it
 * threw away structure the reader has to reconstruct in their head.
 */
function buildScoopsSection(
  scoops: RegisteredScoop[],
  isProcessing: (jid: string) => boolean
): MonitorSection {
  const roots = scoops.filter((scoop) => isRootUnit(scoop));
  const childrenOf = (jid: string): RegisteredScoop[] =>
    scoops.filter((scoop) => !isRootUnit(scoop) && scoop.parentJid === jid);

  const toRow = (scoop: RegisteredScoop, depth: number) => {
    const processing = isProcessing(scoop.jid);
    const label = isRootUnit(scoop) ? `${scoop.name || 'sliccy'} (cone)` : scoop.name;
    return {
      name: label,
      meta: processing ? 'working' : 'idle',
      active: processing,
      depth,
    };
  };

  const rows = roots.flatMap((root) => [
    toRow(root, 0),
    ...childrenOf(root.jid).map((child) => toRow(child, 1)),
  ]);
  // Anything whose parent isn't in the list still has to appear — a scoop the
  // reader can see in the switcher must not vanish from the monitor because
  // its parent was dropped.
  const placed = new Set(rows.map((row) => row.name));
  for (const orphan of scoops) {
    const row = toRow(orphan, 0);
    if (!placed.has(row.name)) rows.push(row);
  }

  const working = scoops.filter((scoop) => isProcessing(scoop.jid)).length;
  return {
    id: 'scoops',
    label: 'Scoops',
    icon: 'bot',
    count: scoops.length,
    meta: `${scoops.length} · ${working} working`,
    accent: 'violet',
    status: 'active',
    emptyText: 'Delegate a focused task and its scoop will show up here.',
    rows,
  };
}

function buildMountsSection(mounts: MountMonitorRow[]): MonitorSection {
  const broken = mounts.filter((mount) => mount.valid === false).length;
  return {
    id: 'mounts',
    label: 'Mounts',
    icon: 'hard-drive',
    count: mounts.length,
    meta:
      broken > 0
        ? `${mounts.length} · ${broken} need${broken === 1 ? 's' : ''} re-grant`
        : `${mounts.length} · all granted`,
    status: broken > 0 ? 'warn' : 'active',
    emptyText: 'Mount a folder to give the workspace access to files on disk.',
    rows: mounts.map((mount) => ({
      name: mount.targetPath,
      meta: mount.valid === false ? 'permission lost' : mount.descriptor.kind,
      // valid === true  → healthy (permission confirmed as of this render)
      // valid === false → attention (needs recovery as of this render)
      // valid === undefined (remote backends) → neutral, no check made
      status: mount.valid === true ? 'active' : mount.valid === false ? 'warn' : 'idle',
    })),
  };
}

/**
 * MCP servers and provider accounts in one group. They were two cards with
 * identical chrome and one row each; as a reader question they are the same
 * one — "can SLICC still reach the things it talks to".
 */
function buildIntegrationsSection(
  mcpEntries: [string, { tools?: unknown[] }][],
  oauthProviders: OAuthProviderEntry[]
): MonitorSection {
  const expired = oauthProviders.filter((provider) => provider.valid === false).length;
  const tools = mcpEntries.reduce((sum, [, entry]) => sum + (entry.tools?.length ?? 0), 0);
  const summary = [
    `${mcpEntries.length} server${mcpEntries.length === 1 ? '' : 's'}`,
    `${tools} tool${tools === 1 ? '' : 's'}`,
    expired > 0 ? `${expired} account expired` : `${oauthProviders.length} accounts valid`,
  ].join(' · ');
  return {
    id: 'integrations',
    label: 'Integrations',
    icon: 'blocks',
    count: mcpEntries.length + oauthProviders.length,
    meta: summary,
    accent: 'waffle',
    status: expired > 0 ? 'error' : 'active',
    emptyText: 'Connect an MCP server or a provider account to extend the workspace.',
    rows: [
      ...mcpEntries.map(([name, entry]) => {
        const toolCount = entry.tools?.length ?? 0;
        return {
          name,
          meta: `MCP · ${toolCount} tool${toolCount === 1 ? '' : 's'}`,
          status: 'active' as MonitorStatus,
        };
      }),
      ...oauthProviders.map((provider) => ({
        name: provider.providerId,
        meta: provider.valid === false ? 'session expired' : 'account',
        status: (provider.valid === true
          ? 'active'
          : provider.valid === false
            ? 'error'
            : 'idle') as MonitorStatus,
      })),
    ],
  };
}

/** Cron tasks and webhooks: both are "something else can start work here". */
function buildAutomationsSection(
  cronTasks: CronTaskEntry[],
  webhooks: WebhookEntry[]
): MonitorSection {
  const summary = [
    `${webhooks.length} webhook${webhooks.length === 1 ? '' : 's'}`,
    cronTasks.length > 0
      ? `${cronTasks.length} cron task${cronTasks.length === 1 ? '' : 's'}`
      : 'no cron tasks',
  ].join(' · ');
  return {
    id: 'automations',
    label: 'Automations',
    icon: 'calendar-clock',
    count: cronTasks.length + webhooks.length,
    meta: summary,
    accent: 'amber',
    emptyText: 'Scheduled tasks and webhook-driven licks will appear here.',
    rows: [
      ...cronTasks.map((task) => ({
        name: task.name,
        meta: task.cron,
        status: (task.status === 'active' ? 'active' : 'idle') as MonitorStatus,
      })),
      ...webhooks.map((webhook) => ({
        name: webhook.name,
        meta: webhook.scoop ? `→ ${webhook.scoop}` : '→ cone',
        status: 'idle' as MonitorStatus,
      })),
    ],
  };
}

function buildCostSection(stats: MonitorSessionStats | null): MonitorSection {
  return {
    id: 'cost',
    label: 'Cost',
    icon: 'receipt',
    count: stats?.models.length ?? 0,
    meta: stats
      ? `$${stats.totalCost.toFixed(2)} across ${stats.models.length} models`
      : 'no spend yet',
    accent: 'rose',
    emptyText: 'Model usage will be summarized after the first turn.',
    rows:
      stats?.models.map((model) => ({
        name: model.model,
        meta: `$${model.cost.toFixed(4)}`,
        status: 'idle' as MonitorStatus,
      })) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

/**
 * Everything that is degraded, expired, or failing, worst first.
 *
 * Derived from the same state the topology groups render — the point is not
 * new data, it's that a reader shouldn't have to open seven groups to find
 * out whether anything is wrong. Alerts carry `age` only where a real
 * timestamp exists; an invented "2m ago" would be worse than none.
 */
export function buildAlerts(input: {
  tray: MonitorTrayInfo;
  followers: ConnectedFollowerInfo[];
  mounts: MountMonitorRow[];
  oauthProviders: OAuthProviderEntry[];
}): MonitorAlert[] {
  const alerts: MonitorAlert[] = [];

  for (const provider of input.oauthProviders) {
    if (provider.valid !== false) continue;
    alerts.push({
      id: `oauth:${provider.providerId}`,
      severity: 'error',
      icon: 'key-round',
      title: `${provider.providerId} session expired`,
      detail: 'Tool calls through this provider will fail until it is signed in again.',
    });
  }

  const trayState = trayStatus(input.tray);
  if (trayState === 'error' || trayState === 'warn') {
    alerts.push({
      id: 'tray',
      severity: trayState === 'error' ? 'error' : 'warn',
      icon: 'cloud-off',
      title: `Tray ${trayStateLabel(input.tray)}`,
      detail: input.tray.workerBaseUrl
        ? `Worker · ${input.tray.workerBaseUrl}`
        : 'No tray session is established.',
    });
  }

  for (const follower of input.followers) {
    // `followerStatus` only ever reaches 'warn' (stalled) — a follower that
    // dropped entirely is simply absent from the list, so there is no error
    // tier to branch on here.
    if (followerStatus(follower) !== 'warn') continue;
    alerts.push({
      id: `follower:${follower.runtimeId}`,
      severity: 'warn',
      icon: 'radio',
      title: `${followerTitle(follower)} stopped answering`,
      detail: follower.motd ?? follower.runtime ?? 'No heartbeat from this follower.',
      age: followerMeta(follower),
    });
  }

  for (const mount of input.mounts) {
    if (mount.valid !== false) continue;
    alerts.push({
      id: `mount:${mount.targetPath}`,
      severity: 'warn',
      icon: 'folder-lock',
      title: `${mount.targetPath} needs re-grant`,
      detail: 'File System Access permission is no longer granted for this handle.',
    });
  }

  return alerts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Vitals
// ---------------------------------------------------------------------------

function formatRate(rate: number): string {
  return rate >= 100 ? `$${Math.round(rate)}` : `$${rate.toFixed(2)}`;
}

/**
 * The vitals row: rates and ratios, not cardinalities.
 *
 * The figures this replaced (`TRACKED`, `ACTIVE`, `ATTENTION`) summed
 * processes with OAuth providers and mounts. A count of unlike things is not
 * a metric; these are the four numbers the system actually has that answer
 * "how hard is it working, and how close to a limit".
 */
export function buildVitals(input: {
  stats: MonitorSessionStats | null;
  workingUnits: number;
  totalUnits: number;
  liveProcesses: number;
  terminated: number;
  history?: MonitorHistory;
  /**
   * The live roster, used only to name and color the context-fill markers.
   * Optional: a fill whose unit isn't here still gets a dot (see
   * {@link buildContextMarkers}), so the meter never under-reports.
   */
  units?: readonly RegisteredScoop[];
}): MonitorVital[] {
  const { stats, workingUnits, totalUnits, liveProcesses, terminated, history } = input;
  const window = history?.windowLabel();
  const burnRate = stats?.burnRate ?? 0;
  const fills = stats?.fills ?? [];
  const peakFill = fills.reduce((max, f) => Math.max(max, f.fill), 0);

  const vitals: MonitorVital[] = [
    {
      id: 'burn',
      label: 'Burn rate',
      value: formatRate(burnRate),
      unit: '/hour',
      hero: true,
      series: history?.series('burnRate'),
      foot: [stats ? `$${stats.totalCost.toFixed(2)} this session` : 'no spend yet', window]
        .filter(Boolean)
        .join(' · '),
    },
    {
      id: 'load',
      label: 'Agent load',
      value: String(workingUnits),
      unit: `of ${totalUnits} working`,
      accent: 'violet',
      series: history?.series('workingUnits'),
      foot: window ?? undefined,
    },
    {
      id: 'processes',
      label: 'Live processes',
      value: String(liveProcesses),
      unit: liveProcesses === 1 ? 'process' : 'processes',
      accent: 'cyan',
      series: history?.series('liveProcesses'),
      foot:
        terminated > 0
          ? `${terminated.toLocaleString()} exited this session`
          : (window ?? undefined),
    },
  ];

  // Only a real reading gets a meter. With no `fills` the honest thing is to
  // show no tile, not a 0% bar that reads as "context is empty".
  if (fills.length > 0) {
    vitals.push({
      id: 'context',
      label: 'Context fill',
      value: String(Math.round(peakFill * 100)),
      unit: '%',
      ratio: peakFill,
      markers: buildContextMarkers(fills, input.units ?? []),
      accent: peakFill >= 0.9 ? 'rose' : peakFill >= 0.7 ? 'amber' : 'green',
      foot: `fullest of ${fills.length} context window${fills.length === 1 ? '' : 's'}`,
    });
  }

  return vitals;
}

/**
 * One dot per context window, positioned at its own fill and painted in its
 * own unit's chip color.
 *
 * The bar itself reports the PEAK, which is the number that matters for "am I
 * about to compact" but says nothing about who is carrying the weight — five
 * windows at 70% and one at 70% next to four empty ones are the same bar. The
 * dots put the distribution back, and reuse {@link scoopColor} so a unit is
 * the same hue here as on its switcher chip; a private palette would make the
 * reader learn the mapping twice.
 */
export function buildContextMarkers(
  fills: readonly { jid: string; fill: number }[],
  units: readonly RegisteredScoop[]
): MonitorMeterMarker[] {
  const byJid = new Map(units.map((unit) => [unit.jid, unit]));
  return fills.map(({ jid, fill }) => {
    const unit = byJid.get(jid);
    // A fill for a unit that has already left the roster is still a real
    // context window holding real tokens, so it keeps its dot. Hashing the
    // JID gives it a stable palette color and an honest, if terse, label.
    const isRoot = unit ? isRootUnit(unit) : false;
    const name = unit?.name || (unit ? 'sliccy' : jid);
    return {
      id: jid,
      ratio: fill,
      color: scoopColor({ isRoot, name }),
      label: `${isRoot ? `${name} (cone)` : name} — ${Math.round(fill * 100)}% full`,
    };
  });
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

const PROC_STATE_LETTER: Record<string, string> = {
  running: 'R',
  pending: 'S',
  exited: 'Z',
  killed: 'K',
};

function formatElapsed(startedAt: number | undefined, now: number): string | undefined {
  if (!startedAt) return undefined;
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function toProcessRow(proc: MonitorProcess, now: number): MonitorProcessRow {
  return {
    pid: proc.pid,
    ppid: proc.ppid,
    state: PROC_STATE_LETTER[proc.status] ?? '?',
    status: proc.status,
    command: proc.argv,
    scoop: proc.scoop,
    started: proc.startedAt ? new Date(proc.startedAt).toTimeString().slice(0, 5) : undefined,
    elapsed: formatElapsed(proc.startedAt, now),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Fetch monitor data and return the `<slicc-monitor>` model.
 *
 * `history` is optional so callers that don't keep one (tests, the initial
 * render) still get every tile — just without sparklines.
 */
export async function fetchMonitorData(
  deps: MonitorDeps,
  history?: MonitorHistory
): Promise<MonitorModel> {
  const scoops = deps.getScoops();
  const tray = deps.getTrayInfo();
  const followers = deps.getConnectedFollowers();
  const [cronTasks, webhooks, mounts, mcpServers, sessionStats, procSnapshot] = await Promise.all([
    deps.getCronTasks().catch(() => [] as CronTaskEntry[]),
    deps.getWebhooks().catch(() => [] as WebhookEntry[]),
    deps.getMounts().catch(() => [] as MountMonitorRow[]),
    deps.getMcpServers().catch(() => ({}) as Record<string, { url: string; tools?: unknown[] }>),
    deps.getSessionStats().catch(() => null),
    deps.getProcesses().catch(() => ({ processes: [], terminated: 0 }) as MonitorProcessSnapshot),
  ]);
  const { processes, terminated } = procSnapshot;
  const oauthProviders = deps.getOAuthProviders();
  const mcpEntries = Object.entries(mcpServers);
  const workingUnits = scoops.filter((scoop) => deps.isProcessing(scoop.jid)).length;
  const now = Date.now();

  history?.push({
    at: now,
    burnRate: sessionStats?.burnRate ?? 0,
    workingUnits,
    liveProcesses: processes.length,
  });

  return {
    updated: 'Streaming · updated just now',
    vitals: buildVitals({
      stats: sessionStats,
      workingUnits,
      totalUnits: scoops.length,
      liveProcesses: processes.length,
      terminated,
      history,
      units: scoops,
    }),
    alerts: buildAlerts({ tray, followers, mounts, oauthProviders }),
    sections: [
      buildTraySection(tray),
      buildFollowersSection(followers),
      buildScoopsSection(scoops, (jid) => deps.isProcessing(jid)),
      buildMountsSection(mounts),
      buildIntegrationsSection(mcpEntries, oauthProviders),
      buildAutomationsSection(cronTasks, webhooks),
      buildCostSection(sessionStats),
    ],
    processes: {
      rows: processes.map((proc) => toProcessRow(proc, now)),
      terminated,
    },
  };
}
