import type {
  MonitorAlert,
  MonitorMeterMarker,
  MonitorModel,
  MonitorProcessRow,
  MonitorRow,
  MonitorSection,
  MonitorStatus,
  MonitorVital,
} from '@slicc/webcomponents';
import type { MountTableEntry } from '../../fs/mount-table-store.js';
import type { SessionBudgetWindow } from '../../kernel/messages.js';
import {
  BUDGET_CRITICAL_PERCENT,
  BUDGET_WARN_PERCENT,
  budgetLevel,
  formatBudgetPercent,
  formatBudgetResets,
} from '../../providers/provider-budget.js';
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

type MountMonitorRow = MountTableEntry & { valid?: boolean };

export interface OAuthProviderEntry {
  providerId: string;
  valid?: boolean;
}

export interface MonitorProcess {
  pid: number;
  ppid?: number;
  argv: string;
  status: string;
  scoop?: string;
  startedAt?: number;
}

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

export interface MonitorSessionStats {
  totalCost: number;
  burnRate?: number;
  models: { model: string; cost: number }[];
  scoops: { name: string; cost: number }[];
  fills?: { jid: string; fill: number }[];

  budget?: SessionBudgetWindow;
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

      status: mount.valid === true ? 'active' : mount.valid === false ? 'warn' : 'idle',
    })),
  };
}

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

function budgetSectionStatus(budget: SessionBudgetWindow): MonitorStatus {
  const level = budgetLevel({ percent: budget.percent, status: budget.status });
  if (level === 'critical') return 'error';
  return level === 'warn' ? 'warn' : 'active';
}

function budgetRow(budget: SessionBudgetWindow, now: number): MonitorRow {
  const figure = `${formatBudgetPercent(budget.percent)}% used`;
  const resets = formatBudgetResets(budget.resetsAt, now);
  return {
    name: `${budget.window[0]?.toUpperCase() ?? ''}${budget.window.slice(1)} budget`,
    sublabel: budget.providerId ? `${budget.providerId} · rolling window` : 'rolling window',
    meta: budget.status === 'rate-limited' ? `rate-limited · ${figure}` : figure,
    badges: resets ? [resets] : undefined,
    status: budgetSectionStatus(budget),
  };
}

function buildCostSection(stats: MonitorSessionStats | null, now: number): MonitorSection {
  const budget = stats?.budget;
  const models = stats?.models ?? [];
  const spend = stats ? `$${stats.totalCost.toFixed(2)} across ${models.length} models` : '';

  const meta = budget
    ? [
        budget.status === 'rate-limited' ? 'rate-limited' : '',
        `${formatBudgetPercent(budget.percent)}% of ${budget.window} budget`,
        spend,
      ]
        .filter(Boolean)
        .join(' · ')
    : stats
      ? spend
      : 'no spend yet';
  return {
    id: 'cost',
    label: 'Cost',
    icon: 'receipt',
    count: models.length,
    meta,
    accent: 'rose',
    status: budget ? budgetSectionStatus(budget) : undefined,
    emptyText: 'Model usage will be summarized after the first turn.',
    rows: [
      ...(budget ? [budgetRow(budget, now)] : []),
      ...models.map((model) => ({
        name: model.model,
        meta: `$${model.cost.toFixed(4)}`,
        status: 'idle' as MonitorStatus,
      })),
    ],
  };
}

export function buildAlerts(input: {
  tray: MonitorTrayInfo;
  followers: ConnectedFollowerInfo[];
  mounts: MountMonitorRow[];
  oauthProviders: OAuthProviderEntry[];

  budget?: SessionBudgetWindow;

  now?: number;
}): MonitorAlert[] {
  const alerts: MonitorAlert[] = [];

  const budgetAlert = buildBudgetAlert(input.budget, input.now ?? Date.now());
  if (budgetAlert) alerts.push(budgetAlert);

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

function buildBudgetAlert(
  budget: SessionBudgetWindow | undefined,
  now: number
): MonitorAlert | null {
  if (!budget) return null;
  const level = budgetLevel({ percent: budget.percent, status: budget.status });
  if (level === 'ok') return null;
  const age = formatBudgetResets(budget.resetsAt, now);
  const figure = `${formatBudgetPercent(budget.percent)}%`;
  if (budget.status === 'rate-limited') {
    return {
      id: 'budget:rate-limited',
      severity: 'error',
      icon: 'octagon-alert',
      title: `${budget.window} budget is rate-limited`,
      detail: `The provider is refusing calls until the window resets. ${figure} of the allowance is used.`,
      age,
    };
  }
  const critical = budget.percent >= BUDGET_CRITICAL_PERCENT;
  return {
    id: 'budget:near-limit',
    severity: critical ? 'error' : 'warn',
    icon: 'gauge',
    title: `${figure} of the ${budget.window} budget used`,
    detail: critical
      ? `Past ${BUDGET_CRITICAL_PERCENT}% of the allowance — calls may start being refused.`
      : `Past ${BUDGET_WARN_PERCENT}% of the allowance. Long runs may not finish before it resets.`,
    age,
  };
}

function formatRate(rate: number): string {
  return rate >= 100 ? `$${Math.round(rate)}` : `$${rate.toFixed(2)}`;
}

export function buildVitals(input: {
  stats: MonitorSessionStats | null;
  workingUnits: number;
  totalUnits: number;
  liveProcesses: number;
  terminated: number;
  history?: MonitorHistory;

  units?: readonly RegisteredScoop[];

  now?: number;
}): MonitorVital[] {
  const { stats, workingUnits, totalUnits, liveProcesses, terminated, history } = input;
  const window = history?.windowLabel();
  const burnRate = stats?.burnRate ?? 0;
  const fills = stats?.fills ?? [];
  const peakFill = fills.reduce((max, f) => Math.max(max, f.fill), 0);
  const budget = stats?.budget;

  const vitals: MonitorVital[] = [
    {
      id: 'burn',
      label: 'Burn rate',
      value: formatRate(burnRate),
      unit: '/hour',

      hero: !budget,
      accent: budget ? 'rose' : undefined,
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
  ];

  if (!budget) {
    vitals.push({
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
    });
  }

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

  return budget ? [buildBudgetVital(budget, stats, input.now ?? Date.now()), ...vitals] : vitals;
}

function buildBudgetVital(
  budget: SessionBudgetWindow,
  stats: MonitorSessionStats | null,
  now: number
): MonitorVital {
  const level = budgetLevel({ percent: budget.percent, status: budget.status });
  return {
    id: 'budget',
    label: `${budget.window[0]?.toUpperCase() ?? ''}${budget.window.slice(1)} budget`,
    value: formatBudgetPercent(budget.percent),
    unit: '% used',
    hero: true,
    ratio: Math.min(1, Math.max(0, budget.percent / 100)),
    accent: level === 'critical' ? 'rose' : level === 'warn' ? 'amber' : 'green',
    foot: [
      budget.status === 'rate-limited' ? 'rate-limited' : '',
      formatBudgetResets(budget.resetsAt, now) ?? '',
      stats ? `$${stats.totalCost.toFixed(2)} this session` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

export function buildContextMarkers(
  fills: readonly { jid: string; fill: number }[],
  units: readonly RegisteredScoop[]
): MonitorMeterMarker[] {
  const byJid = new Map(units.map((unit) => [unit.jid, unit]));
  return fills.map(({ jid, fill }) => {
    const unit = byJid.get(jid);

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
      now,
    }),
    alerts: buildAlerts({
      tray,
      followers,
      mounts,
      oauthProviders,
      budget: sessionStats?.budget,
      now,
    }),
    sections: [
      buildTraySection(tray),
      buildFollowersSection(followers),
      buildScoopsSection(scoops, (jid) => deps.isProcessing(jid)),
      buildMountsSection(mounts),
      buildIntegrationsSection(mcpEntries, oauthProviders),
      buildAutomationsSection(cronTasks, webhooks),
      buildCostSection(sessionStats, now),
    ],
    processes: {
      rows: processes.map((proc) => toProcessRow(proc, now)),
      terminated,
    },
  };
}
