/**
 * `uptime` — how long this SLICC has been up, and how busy it has been.
 *
 * Advertised on the homepage and at `/man/uptime` but never implemented, so it
 * answered 127 (#2819). In a browser the "system" is the page: a reload is a
 * reboot, so uptime is measured from the page realm's `performance.timeOrigin`
 * (`base/page-load-time.ts` — the kernel worker gets the page's value at boot,
 * since its own origin is later).
 *
 * The load average is REAL, not the simulated triple the man page promised.
 * SLICC has no scheduler run queue, but it does have a process table, and the
 * kernel `ProcessManager` records `startedAt` / `finishedAt` for every process
 * it ever ran. Averaging how many were alive across the last 1 / 5 / 15
 * minutes is the same quantity Linux reports, computed exactly instead of
 * sampled — see {@link loadAverage} for the one caveat (terminated-process
 * retention).
 */

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

/** The three windows uptime(1) reports, in minutes. */
const LOAD_WINDOWS_MINUTES = [1, 5, 15] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface UptimeCommandOptions {
  /** Injected by the kernel host; tests pass their own. */
  processManager?: ProcessManager;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => number;
  /** Boot-time seam. Defaults to {@link readPageLoadedAt}. */
  bootedAt?: () => number;
}

/** Globals the kernel host publishes for commands that need the live PM. */
interface KernelGlobals {
  __slicc_pm?: unknown;
}

function lookupGlobalPm(): ProcessManager | null {
  const pm = (globalThis as KernelGlobals).__slicc_pm;
  return pm instanceof Object && typeof (pm as ProcessManager).list === 'function'
    ? (pm as ProcessManager)
    : null;
}

/**
 * Average number of processes alive over the `windowMs` ending at `now`.
 *
 * Exact rather than sampled: each process contributes the overlap between its
 * lifetime and the window, and the total is divided by the window. The window
 * is clamped to the elapsed uptime so a runtime that has been up for ten
 * seconds is not reported as one-sixth as busy as it really is.
 *
 * The one inaccuracy is upstream: `ProcessManager` retains a bounded number of
 * terminated records, so processes that ended long enough ago to have been
 * reaped are invisible here and the older windows under-report after a burst.
 */
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

/** `3 days, 4:07` / `4:07` / `7 min` — the shape procps' uptime(1) prints. */
export function formatUptime(elapsedMs: number): string {
  const total = Math.max(0, elapsedMs);
  const days = Math.floor(total / DAY_MS);
  const hours = Math.floor((total % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((total % HOUR_MS) / MINUTE_MS);
  const clock = hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}` : `${minutes} min`;
  if (days === 0) return clock;
  return `${days} ${days === 1 ? 'day' : 'days'}, ${clock}`;
}

/** `up 3 days, 4 hours, 7 minutes` — the `-p` form. */
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

/** `2026-09-04 11:42:07` in local time, as uptime(1) `-s` prints it. */
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

/**
 * The full uptime(1) line. Kept separate from the command so the formatting is
 * testable against a fixed clock and process table.
 */
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

/**
 * Strict argv: uptime takes no operands, so anything unrecognised is an error
 * rather than something quietly ignored.
 */
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
