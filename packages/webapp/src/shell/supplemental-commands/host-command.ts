import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import {
  getLeaderTrayRuntimeStatus,
  type LeaderTrayRuntimeStatus,
} from '../../scoops/tray-leader.js';
import {
  getFollowerTrayRuntimeStatus,
  type FollowerTrayRuntimeStatus,
} from '../../scoops/tray-follower-status.js';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';

export interface ConnectedFollowerInfo {
  runtimeId: string;
  runtime?: string;
  connectedAt?: string;
}

/**
 * Module-level callback for retrieving connected followers.
 * Set by main.ts once the LeaderSyncManager is created.
 */
let connectedFollowersGetter: (() => ConnectedFollowerInfo[]) | null = null;

export function setConnectedFollowersGetter(getter: (() => ConnectedFollowerInfo[]) | null): void {
  connectedFollowersGetter = getter;
}

export function getConnectedFollowers(): ConnectedFollowerInfo[] {
  return connectedFollowersGetter?.() ?? [];
}

/**
 * Module-level callback for resetting the tray session.
 * Set by main.ts once the LeaderTrayManager is created.
 */
let trayResetter: (() => Promise<LeaderTrayRuntimeStatus>) | null = null;

export function setTrayResetter(resetter: (() => Promise<LeaderTrayRuntimeStatus>) | null): void {
  trayResetter = resetter;
}

export function getTrayResetter(): (() => Promise<LeaderTrayRuntimeStatus>) | undefined {
  return trayResetter ?? undefined;
}

// localStorage keys written by page-side subscriptions in main.ts and
// propagated to the kernel worker's Map-backed shim via installPageStorageSync.
const LEADER_STATUS_STORAGE_KEY = 'slicc.leaderTrayStatus';
const LEADER_FOLLOWERS_STORAGE_KEY = 'slicc.leaderTrayFollowers';

// In the standalone-worker path the leader tray runs on the page. The
// worker's module global stays 'inactive', so fall back to the localStorage
// shim value that main.ts keeps current via subscribeToLeaderTrayRuntimeStatus.
function getLeaderStatusWithFallback(): LeaderTrayRuntimeStatus {
  const moduleStatus = getLeaderTrayRuntimeStatus();
  if (moduleStatus.state !== 'inactive') return moduleStatus;
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      LEADER_STATUS_STORAGE_KEY
    );
    if (stored) {
      const parsed = JSON.parse(stored) as LeaderTrayRuntimeStatus;
      if (parsed?.state && parsed.state !== 'inactive') return parsed;
    }
  } catch {
    // ignore parse errors
  }
  return moduleStatus;
}

// Same reason: the module-level getter is only set on the page thread.
// Fall back to the localStorage shim value written by onFollowerCountChanged.
function getFollowersWithFallback(): ConnectedFollowerInfo[] {
  if (connectedFollowersGetter) return connectedFollowersGetter();
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      LEADER_FOLLOWERS_STORAGE_KEY
    );
    if (stored) return JSON.parse(stored) as ConnectedFollowerInfo[];
  } catch {
    // ignore parse errors
  }
  return [];
}

// When `host reset` runs from the kernel-worker's terminal, the worker's
// module-level `trayResetter` is null (the page is the only side that
// calls `setTrayResetter`). Bridge to the page via panel-RPC so the
// `tray-reset` handler installed in `mainStandaloneWorker` can drive
// `pageLeaderTray.reset()`. Returns `undefined` when no panel-RPC client
// is published (e.g. in tests, or in extension mode where the offscreen
// document has its own DOM and doesn't need the bridge).
function buildPanelRpcResetter(): (() => Promise<LeaderTrayRuntimeStatus>) | undefined {
  const client = getPanelRpcClient();
  if (!client) return undefined;
  return async () => await client.call('tray-reset', undefined);
}

export interface HostCommandOptions {
  getStatus?: () => LeaderTrayRuntimeStatus;
  getFollowerStatus?: () => FollowerTrayRuntimeStatus;
  getFollowers?: () => ConnectedFollowerInfo[];
  resetTray?: () => Promise<LeaderTrayRuntimeStatus>;
}

function hostHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `host - display or manage the current tray host status

Usage: host [reset]

Shows the current tray state (leader or follower) and, when available, the join URL and connected followers.

Subcommands:
  reset   Disconnect all followers and create a fresh tray session with a new join URL
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

  if (followers.length > 0) {
    lines.push('followers:');
    for (const f of followers) {
      const parts = [f.runtimeId];
      if (f.runtime) {
        parts.push(`(${f.runtime})`);
      }
      if (f.connectedAt) {
        const ago = Math.round((Date.now() - new Date(f.connectedAt).getTime()) / 1000);
        parts.push(`connected ${formatDuration(ago)}`);
      }
      lines.push(`  - ${parts.join(' ')}`);
    }
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
  const getFollowerSt = options.getFollowerStatus ?? getFollowerTrayRuntimeStatus;
  const getFollowers = options.getFollowers ?? getFollowersWithFallback;

  return defineCommand('host', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return hostHelp();
    }

    if (args[0] === 'reset') {
      // Resolution order for the resetter:
      //   1. options.resetTray — explicit override for tests / future callers.
      //   2. getTrayResetter() — page-thread path; the page sets this via
      //      setTrayResetter after starting pageLeaderTray.
      //   3. Panel-RPC `tray-reset` — worker-thread path. Standalone runs
      //      the host shell command inside the kernel worker, where the
      //      module-level trayResetter is null; bridge to the page so it
      //      can drive pageLeaderTray.reset(). Returns the new
      //      LeaderTrayRuntimeStatus.
      const resetter = options.resetTray ?? getTrayResetter() ?? buildPanelRpcResetter();
      return handleReset(getFollowerSt, getStatus, resetter);
    }

    if (args.length > 0) {
      return {
        stdout: '',
        stderr: 'host: unsupported arguments\n',
        exitCode: 1,
      };
    }

    // Show follower status if follower is active (connecting, connected, or error)
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

async function handleReset(
  getFollowerStatus: () => FollowerTrayRuntimeStatus,
  getLeaderStatus: () => LeaderTrayRuntimeStatus,
  resetTray: (() => Promise<LeaderTrayRuntimeStatus>) | undefined
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Only leaders can reset
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
