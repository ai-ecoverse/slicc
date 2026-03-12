import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import {
  getLeaderTrayRuntimeStatus,
  type LeaderTrayRuntimeStatus,
} from '../../scoops/tray-leader.js';
import { buildTrayLaunchUrl, buildTrayUrlValue } from '../../scoops/tray-runtime-config.js';

export interface HostCommandOptions {
  getStatus?: () => LeaderTrayRuntimeStatus;
  getLocationHref?: () => string | null;
}

function hostHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `host - display the current tray host status

Usage: host

Shows the current leader tray state and, when available, the canonical tray launch URL and join URL.
`,
    stderr: '',
    exitCode: 0,
  };
}

function formatHostOutput(status: LeaderTrayRuntimeStatus, locationHref: string | null): string {
  const lines = [`status: ${status.state}`];

  if (status.session) {
    const launchUrl = status.state === 'leader'
      ? buildTrayUrlValue(status.session.workerBaseUrl, status.session.trayId)
      : locationHref
        ? buildTrayLaunchUrl(locationHref, status.session.workerBaseUrl, status.session.trayId)
        : null;
    lines.push(`launch_url: ${launchUrl ?? 'unavailable'}`);
    lines.push(`join_url: ${status.session.joinUrl}`);
    lines.push(`worker_base_url: ${status.session.workerBaseUrl}`);
    lines.push(`tray_id: ${status.session.trayId}`);
  } else {
    lines.push('launch_url: unavailable');
    lines.push('join_url: unavailable');
  }

  if (status.error) {
    lines.push(`error: ${status.error}`);
  }

  return `${lines.join('\n')}\n`;
}

export function createHostCommand(options: HostCommandOptions = {}): Command {
  const getStatus = options.getStatus ?? getLeaderTrayRuntimeStatus;
  const getLocationHref = options.getLocationHref ?? (() => globalThis.location?.href ?? null);

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

    return {
      stdout: formatHostOutput(getStatus(), getLocationHref()),
      stderr: '',
      exitCode: 0,
    };
  });
}