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

export interface ConnectedFollowerInfo {
  runtimeId: string;
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

export interface HostCommandOptions {
  getStatus?: () => LeaderTrayRuntimeStatus;
  getFollowerStatus?: () => FollowerTrayRuntimeStatus;
  getFollowers?: () => ConnectedFollowerInfo[];
}

function hostHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `host - display the current tray host status

Usage: host

Shows the current tray state (leader or follower) and, when available, the join URL and connected followers.
`,
    stderr: '',
    exitCode: 0,
  };
}

export function formatLeaderOutput(status: LeaderTrayRuntimeStatus, followers: ConnectedFollowerInfo[]): string {
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
      lines.push(`  - ${f.runtimeId}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function formatFollowerOutput(status: FollowerTrayRuntimeStatus): string {
  const lines = [`status: follower (${status.state})`];

  if (status.joinUrl) {
    lines.push(`join_url: ${status.joinUrl}`);
  }
  if (status.state === 'connected' && status.lastPingTime != null) {
    const ago = Math.round((Date.now() - status.lastPingTime) / 1000);
    lines.push(`last_ping: ${ago}s ago`);
  }
  if (status.state === 'reconnecting' && status.reconnectAttempts > 0) {
    lines.push(`reconnect_attempts: ${status.reconnectAttempts}`);
  }
  if (status.error) {
    lines.push(`error: ${status.error}`);
  }

  return `${lines.join('\n')}\n`;
}

export function createHostCommand(options: HostCommandOptions = {}): Command {
  const getStatus = options.getStatus ?? getLeaderTrayRuntimeStatus;
  const getFollowerSt = options.getFollowerStatus ?? getFollowerTrayRuntimeStatus;
  const getFollowers = options.getFollowers ?? getConnectedFollowers;

  return defineCommand('host', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return hostHelp();
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
