import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { readPageLoadedAt } from '../../base/page-load-time.js';
import { readSliccVersion } from '../../base/slicc-version.js';
import type { Process, ProcessManager } from '../../kernel/process-manager.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

const USAGE = 'usage: uptime [-p|--pretty] [-s|--since]';

const HELP = `${USAGE}

Print how long this SLICC has been running. The clock starts when the browser
window was last loaded — a reload is a reboot.

Options:
  -p, --pretty   Uptime in words, nothing else.
  -s, --since    The epoch-start timestamp instead of the elapsed time.
  --help         This text.
  --version      Print the SLICC build.

The load average is the average number of live kernel processes over the last
1, 5 and 15 minutes, computed from the process table \`ps\` reads. Terminated
processes are retained in bounded numbers, so a long burst of short commands
can under-report the older windows. The user count is always 1: a SLICC
runtime has one user identity (see \`id\`).
`;

const LOAD_WINDOWS_MINUTES = [1, 5, 15] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface UptimeCommandOptions {
  processManager?: ProcessManager;

  now?: () => number;

  bootedAt?: () => number;
}

interface KernelGlobals {
  __slicc_pm?: unknown;
}

function lookupGlobalPm(): ProcessManager | null {
  const pm = (globalThis as KernelGlobals).__slicc_pm;
  return pm instanceof Object && typeof (pm as ProcessManager).list === 'function'
    ? (pm as ProcessManager)
    : null;
}

export function loadAverage(
  processes: readonly Process[],
  now: number,
  windowMs: number,
  bootedAt: number
): number {
  const span = Math.min(windowMs, Math.max(1, now - bootedAt));
  const windowStart = now - span;
  let busyMs = 0;
  for (const proc of processes) {
    const end = Math.min(proc.finishedAt ?? now, now);
    busyMs += Math.max(0, end - Math.max(proc.startedAt, windowStart));
  }
  return busyMs / span;
}

export function formatUptime(elapsedMs: number): string {
  const total = Math.max(0, elapsedMs);
  const days = Math.floor(total / DAY_MS);
  const hours = Math.floor((total % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((total % HOUR_MS) / MINUTE_MS);
  const clock = hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}` : `${minutes} min`;
  if (days === 0) return clock;
  return `${days} ${days === 1 ? 'day' : 'days'}, ${clock}`;
}

export function formatPretty(elapsedMs: number): string {
  const total = Math.max(0, elapsedMs);
  const parts: string[] = [];
  const push = (value: number, unit: string): void => {
    if (value > 0) parts.push(`${value} ${unit}${value === 1 ? '' : 's'}`);
  };
  push(Math.floor(total / DAY_MS), 'day');
  push(Math.floor((total % DAY_MS) / HOUR_MS), 'hour');
  push(Math.floor((total % HOUR_MS) / MINUTE_MS), 'minute');
  if (parts.length === 0) return `up ${Math.floor(total / 1000)} seconds`;
  return `up ${parts.join(', ')}`;
}

export function formatSince(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function clockOf(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

export function renderUptime(processes: readonly Process[], now: number, bootedAt: number): string {
  const loads = LOAD_WINDOWS_MINUTES.map((minutes) =>
    loadAverage(processes, now, minutes * MINUTE_MS, bootedAt).toFixed(2)
  );
  return (
    ` ${clockOf(now)} up ${formatUptime(now - bootedAt)},` +
    `  1 user,  load average: ${loads.join(', ')}\n`
  );
}

type Mode = 'default' | 'pretty' | 'since' | 'help' | 'version';

export function parseUptimeArgs(args: readonly string[]): Mode | { error: string } {
  let mode: Mode = 'default';
  for (const arg of args) {
    switch (arg) {
      case '-p':
      case '--pretty':
        mode = 'pretty';
        break;
      case '-s':
      case '--since':
        mode = 'since';
        break;
      case '-h':
      case '--help':
        return 'help';
      case '--version':
        return 'version';
      default:
        return { error: `unrecognized option '${arg}'` };
    }
  }
  return mode;
}

export function createUptimeCommand(options: UptimeCommandOptions = {}): Command {
  return defineCommand('uptime', async (args) => {
    const parsed = parseUptimeArgs(args);
    if (typeof parsed !== 'string') {
      return { stdout: '', stderr: `uptime: ${parsed.error}\n${USAGE}\n`, exitCode: 1 };
    }
    if (parsed === 'help') return { stdout: HELP, stderr: '', exitCode: 0 };
    if (parsed === 'version') {
      return { stdout: `uptime (SLICC) ${readSliccVersion().version}\n`, stderr: '', exitCode: 0 };
    }

    const now = options.now ? options.now() : Date.now();
    const bootedAt = options.bootedAt ? options.bootedAt() : readPageLoadedAt();
    if (parsed === 'since') return ok(`${formatSince(bootedAt)}\n`);
    if (parsed === 'pretty') return ok(`${formatPretty(now - bootedAt)}\n`);

    const pm = options.processManager ?? lookupGlobalPm();
    return ok(renderUptime(pm ? pm.list() : [], now, bootedAt));
  });
}

function ok(stdout: string): CmdResult {
  return { stdout, stderr: '', exitCode: 0 };
}
