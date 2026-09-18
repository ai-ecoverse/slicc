import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import {
  type FollowerTrayRuntimeStatus,
  getFollowerStatusWithFallback,
  getFollowerTrayRuntimeStatus,
} from '../../base/tray-follower-status.js';
import { joinTray as defaultJoinTray } from '../../base/tray-join.js';
import {
  getLeaderStatusWithFallback,
  type LeaderTrayRuntimeStatus,
} from '../../base/tray-leader-status.js';
import { leaveTray as defaultLeaveTray, type TrayLeaveResult } from '../../base/tray-leave.js';
import type { FloatType } from '../../base/tray-role.js';
import { normalizeTrayWorkerBaseUrl, parseTrayJoinUrlValue } from '../../base/tray-url-config.js';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';

export interface ConnectedFollowerInfo {
  runtimeId: string;
  runtime?: string;
  connectedAt?: string;
  floatType?: FloatType;
  hostOrigin?: string;
  selectedScoopJid?: string;
  health?: 'live' | 'stalled';
  peerState?: 'connecting' | 'connected';

  exec?: boolean;

  computer?: boolean;

  cdp?: boolean;

  motd?: string;
}

let connectedFollowersGetter: (() => ConnectedFollowerInfo[]) | null = null;

export function setConnectedFollowersGetter(getter: (() => ConnectedFollowerInfo[]) | null): void {
  connectedFollowersGetter = getter;
}

export function getConnectedFollowers(): ConnectedFollowerInfo[] {
  return connectedFollowersGetter?.() ?? [];
}

let trayResetter: (() => Promise<LeaderTrayRuntimeStatus>) | null = null;

export function setTrayResetter(resetter: (() => Promise<LeaderTrayRuntimeStatus>) | null): void {
  trayResetter = resetter;
}

export function getTrayResetter(): (() => Promise<LeaderTrayRuntimeStatus>) | undefined {
  return trayResetter ?? undefined;
}

const LEADER_FOLLOWERS_STORAGE_KEY = 'slicc.leaderTrayFollowers';

export function getConnectedFollowersWithFallback(): ConnectedFollowerInfo[] {
  return getFollowersWithFallback();
}

function getFollowersWithFallback(): ConnectedFollowerInfo[] {
  if (connectedFollowersGetter) return connectedFollowersGetter();
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      LEADER_FOLLOWERS_STORAGE_KEY
    );
    if (stored) return JSON.parse(stored) as ConnectedFollowerInfo[];
  } catch {}
  return [];
}

export function writeConnectedFollowersToShim(
  followers: ConnectedFollowerInfo[],
  storage: Pick<Storage, 'setItem'> | undefined = (globalThis as { localStorage?: Storage })
    .localStorage
): void {
  try {
    storage?.setItem(LEADER_FOLLOWERS_STORAGE_KEY, JSON.stringify(followers));
  } catch {}
}

function buildPanelRpcResetter(): (() => Promise<LeaderTrayRuntimeStatus>) | undefined {
  const client = getPanelRpcClient();
  if (!client) return undefined;
  return async () => await client.call('tray-reset', undefined);
}

export type { TrayLeaveResult } from '../../base/tray-leave.js';

export interface HostCommandOptions {
  getStatus?: () => LeaderTrayRuntimeStatus;
  getFollowerStatus?: () => FollowerTrayRuntimeStatus;
  getFollowers?: () => ConnectedFollowerInfo[];
  resetTray?: () => Promise<LeaderTrayRuntimeStatus>;

  leaveTray?: (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }) => Promise<TrayLeaveResult>;

  joinTray?: (opts: { joinUrl: string; requestId?: string }) => Promise<void>;
}

function hostHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `host - display or manage the current tray host status

Usage: host [join <join-url> | reset | leave [--leader <worker-url>]]

Shows the current tray state (leader or follower) and, when available, the join URL and connected followers.

Subcommands:
  join <join-url>             Follow another browser's tray as a follower (paste its https://…/join/<token> URL)
  reset                       Disconnect all followers and create a fresh tray session with a new join URL
  leave                       Leave the current tray (drops follower or stops leader; clears stored URLs)
  leave --leader <worker-url> Leave the current role and immediately become a leader on <worker-url>
`,
    stderr: '',
    exitCode: 0,
  };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}h ago`;
  return `${hours}h ${remainingMinutes}m ago`;
}

function formatFollowerEntry(f: ConnectedFollowerInfo): string[] {
  const parts = [f.runtimeId];
  if (f.runtime) {
    parts.push(`(${f.runtime})`);
  }
  if (f.connectedAt) {
    const ago = Math.round((Date.now() - new Date(f.connectedAt).getTime()) / 1000);
    parts.push(`connected ${formatDuration(ago)}`);
  }
  const tags: string[] = [];
  if (f.exec) tags.push('[ssh]');
  if (f.cdp) tags.push('[playwright]');
  if (tags.length > 0) parts.push(tags.join(' '));
  const lines = [`  - ${parts.join(' ')}`];
  if (f.exec && f.motd) lines.push(`      ${f.motd}`);
  return lines;
}

function formatFollowersSection(followers: ConnectedFollowerInfo[]): string[] {
  const actionable = followers.filter((f) => f.exec || f.cdp);
  const hidden = followers.length - actionable.length;
  const lines: string[] = [];
  if (actionable.length > 0) {
    lines.push('followers:');
    for (const f of actionable) lines.push(...formatFollowerEntry(f));
  }
  if (hidden > 0) {
    lines.push(
      `(${hidden} other follower${hidden === 1 ? '' : 's'} with no exec/browser capability)`
    );
  }
  return lines;
}

export function formatLeaderOutput(
  status: LeaderTrayRuntimeStatus,
  followers: ConnectedFollowerInfo[]
): string {
  const lines = [`status: ${status.state}`];

  if (status.session) {
    lines.push(`join_url: ${status.session.joinUrl}`);
  } else {
    lines.push('join_url: unavailable');
  }

  if (status.error) {
    lines.push(`error: ${status.error}`);
  }

  if (status.session) {
    lines.push(...formatFollowersSection(followers));
  }

  return `${lines.join('\n')}\n`;
}

export function formatFollowerOutput(status: FollowerTrayRuntimeStatus): string {
  const lines = [`status: follower (${status.state})`];

  if (status.joinUrl) {
    lines.push(`join_url: ${status.joinUrl}`);
  }
  if (status.state === 'connecting') {
    if (status.connectingSince != null) {
      const elapsedSec = Math.round((Date.now() - status.connectingSince) / 1000);
      lines.push(`connecting_for: ${formatDuration(elapsedSec).replace(' ago', '')}`);
    }
    if (status.attachAttempts > 0) {
      lines.push(`attach_attempts: ${status.attachAttempts}`);
    }
    if (status.lastAttachCode) {
      lines.push(`last_code: ${status.lastAttachCode}`);
    }
  }
  if (status.state === 'connected' && status.lastPingTime != null) {
    const ago = Math.round((Date.now() - status.lastPingTime) / 1000);
    lines.push(`last_ping: ${ago}s ago`);
  }
  if (status.state === 'reconnecting' && status.reconnectAttempts > 0) {
    lines.push(`reconnect_attempts: ${status.reconnectAttempts}`);
  }
  if (status.lastError) {
    lines.push(`last_error: ${status.lastError}`);
  }
  if (status.error) {
    lines.push(`error: ${status.error}`);
  }

  return `${lines.join('\n')}\n`;
}

export function createHostCommand(options: HostCommandOptions = {}): Command {
  const getStatus = options.getStatus ?? getLeaderStatusWithFallback;

  const getFollowerSt = options.getFollowerStatus ?? getFollowerStatusWithFallback;
  const getFollowers = options.getFollowers ?? getFollowersWithFallback;

  return defineCommand('host', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return hostHelp();
    }

    if (args[0] === 'reset') {
      const resetter = options.resetTray ?? getTrayResetter() ?? buildPanelRpcResetter();
      return handleReset(getFollowerSt, getStatus, resetter);
    }

    if (args[0] === 'join') {
      const joiner = options.joinTray ?? buildDefaultJoiner();
      return handleJoin(args.slice(1), joiner);
    }

    if (args[0] === 'leave') {
      const leaver = options.leaveTray ?? buildDefaultLeaver();
      return handleLeave(args.slice(1), getStatus, getFollowerSt, leaver);
    }

    if (args.length > 0) {
      return {
        stdout: '',
        stderr: 'host: unsupported arguments\n',
        exitCode: 1,
      };
    }

    const followerStatus = getFollowerSt();
    if (followerStatus.state !== 'inactive') {
      return {
        stdout: formatFollowerOutput(followerStatus),
        stderr: '',
        exitCode: 0,
      };
    }

    return {
      stdout: formatLeaderOutput(getStatus(), getFollowers()),
      stderr: '',
      exitCode: 0,
    };
  });
}

function buildDefaultLeaver(): (opts: {
  workerBaseUrl: string | null;
  requestId?: string;
}) => Promise<TrayLeaveResult> {
  return async ({ workerBaseUrl, requestId }) => {
    const panelRpcClient = getPanelRpcClient();

    if (panelRpcClient) {
      return await panelRpcClient.call('tray-leave', { workerBaseUrl, requestId });
    }

    const followerSt = getFollowerTrayRuntimeStatus();
    const leaderSt = getLeaderStatusWithFallback();
    const previousMode: 'leader' | 'follower' | 'inactive' =
      followerSt.state !== 'inactive'
        ? 'follower'
        : leaderSt.state !== 'inactive'
          ? 'leader'
          : 'inactive';

    await defaultLeaveTray({ workerBaseUrl, requestId });

    if (workerBaseUrl !== null) {
      return { kind: 'switched', previousMode, workerBaseUrl };
    }
    if (previousMode === 'inactive') {
      return { kind: 'noop' };
    }
    return { kind: 'left', previousMode };
  };
}

function newLeaveRequestId(): string {
  return `host-leave-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newJoinRequestId(): string {
  return `host-join-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildDefaultJoiner(): (opts: { joinUrl: string; requestId?: string }) => Promise<void> {
  return async ({ joinUrl, requestId }) => {
    const panelRpcClient = getPanelRpcClient();
    if (panelRpcClient) {
      await panelRpcClient.call('tray-join', { joinUrl, requestId });
      return;
    }
    await defaultJoinTray(joinUrl, { requestId });
  };
}

async function handleJoin(
  args: string[],
  joinTrayImpl: (opts: { joinUrl: string; requestId?: string }) => Promise<void>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let rawUrl: string | undefined;
  for (const arg of args) {
    if (arg.startsWith('-') || rawUrl !== undefined) {
      return {
        stdout: '',
        stderr: `host join: unexpected argument: ${arg}\n`,
        exitCode: 1,
      };
    }
    rawUrl = arg;
  }
  if (!rawUrl) {
    return {
      stdout: '',
      stderr: 'host join: missing join URL\nUsage: host join <join-url>\n',
      exitCode: 1,
    };
  }

  const parsed = parseTrayJoinUrlValue(rawUrl);
  if (!parsed) {
    return {
      stdout: '',
      stderr:
        `host join: invalid join URL: ${rawUrl}\n` +
        'Expected an https://…/join/<token> link from the leader’s "Copy tray join URL".\n',
      exitCode: 1,
    };
  }

  try {
    await joinTrayImpl({ joinUrl: parsed.joinUrl, requestId: newJoinRequestId() });
    return {
      stdout:
        `Joining tray as follower: ${parsed.joinUrl}\n` +
        'Run `host` to check connection status.\n',
      stderr: '',
      exitCode: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: '', stderr: `host join: ${message}\n`, exitCode: 1 };
  }
}

async function handleLeave(
  args: string[],
  getLeaderStatus: () => LeaderTrayRuntimeStatus,
  getFollowerStatus: () => FollowerTrayRuntimeStatus,
  leaveTrayImpl: (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }) => Promise<TrayLeaveResult>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let workerBaseUrl: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--leader' || arg === '--as-leader') {
      const value = args[i + 1];
      if (!value) {
        return {
          stdout: '',
          stderr: `host leave: ${arg} requires a worker base URL argument\n`,
          exitCode: 1,
        };
      }
      const normalized = normalizeTrayWorkerBaseUrl(value);
      if (!normalized) {
        return {
          stdout: '',
          stderr: `host leave: invalid worker base URL: ${value}\n`,
          exitCode: 1,
        };
      }
      workerBaseUrl = normalized;
      i += 1;
      continue;
    }
    return {
      stdout: '',
      stderr: `host leave: unexpected argument: ${arg}\n`,
      exitCode: 1,
    };
  }

  if (workerBaseUrl === null) {
    const leaderStatus = getLeaderStatus();
    const followerStatus = getFollowerStatus();
    if (leaderStatus.state === 'inactive' && followerStatus.state === 'inactive') {
      return {
        stdout: '',
        stderr: 'host leave: no active tray session\n',
        exitCode: 0,
      };
    }
  }

  try {
    const result = await leaveTrayImpl({ workerBaseUrl, requestId: newLeaveRequestId() });
    return { stdout: formatLeaveResult(result), stderr: '', exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (workerBaseUrl !== null) {
      return {
        stdout: '',
        stderr:
          `host leave: left the tray, but failed to become leader on ${workerBaseUrl}: ${message}\n` +
          'Tray runtime is now dormant.\n',
        exitCode: 1,
      };
    }
    return {
      stdout: '',
      stderr: `host leave: ${message}\n`,
      exitCode: 1,
    };
  }
}

function formatLeaveResult(result: TrayLeaveResult): string {
  switch (result.kind) {
    case 'noop':
      return 'No active tray session.\n';
    case 'left': {
      const mode = result.previousMode;
      switch (mode) {
        case 'leader':
          return 'Stopped leader. Tray runtime is now dormant.\n';
        case 'follower':
          return 'Disconnected from leader. Tray runtime is now dormant.\n';
        default:
          return assertUnreachable(mode);
      }
    }
    case 'switched': {
      const mode = result.previousMode;
      switch (mode) {
        case 'leader':
          return `Stopped leader. Now leader on ${result.workerBaseUrl}\n`;
        case 'follower':
          return `Disconnected from leader. Now leader on ${result.workerBaseUrl}\n`;
        case 'inactive':
          return `Now leader on ${result.workerBaseUrl}\n`;
        default:
          return assertUnreachable(mode);
      }
    }
    default:
      return assertUnreachable(result);
  }
}

function assertUnreachable(value: never): never {
  throw new Error(`formatLeaveResult: unhandled variant ${JSON.stringify(value)}`);
}

async function handleReset(
  getFollowerStatus: () => FollowerTrayRuntimeStatus,
  getLeaderStatus: () => LeaderTrayRuntimeStatus,
  resetTray: (() => Promise<LeaderTrayRuntimeStatus>) | undefined
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const followerStatus = getFollowerStatus();
  if (followerStatus.state !== 'inactive') {
    return {
      stdout: '',
      stderr: 'host reset: only the leader can reset the tray session\n',
      exitCode: 1,
    };
  }

  const leaderStatus = getLeaderStatus();
  if (leaderStatus.state !== 'leader' && leaderStatus.state !== 'error') {
    return {
      stdout: '',
      stderr: 'host reset: no active tray session to reset\n',
      exitCode: 1,
    };
  }

  if (!resetTray) {
    return {
      stdout: '',
      stderr: 'host reset: tray reset is not available in this environment\n',
      exitCode: 1,
    };
  }

  try {
    const newStatus = await resetTray();
    const output =
      'Tray session reset. All followers disconnected.\n' + formatLeaderOutput(newStatus, []);
    return { stdout: output, stderr: '', exitCode: 0 };
  } catch (error) {
    return {
      stdout: '',
      stderr: `host reset: ${error instanceof Error ? error.message : String(error)}\n`,
      exitCode: 1,
    };
  }
}
