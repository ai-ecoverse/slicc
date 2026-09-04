/**
 * `uptime` was advertised on the homepage and at /man/uptime but answered 127
 * (#2819). What it should report is time since the browser window was last
 * loaded, and — instead of the "simulated" load average the man page promised
 * — the real average process count from the kernel process table.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { readPageLoadedAt, setPageLoadedAt } from '../../../src/base/page-load-time.js';
import { VirtualFS } from '../../../src/fs/index.js';
import type { Process } from '../../../src/kernel/process-manager.js';
import { ProcessManager } from '../../../src/kernel/process-manager.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands/index.js';
import {
  createUptimeCommand,
  formatPretty,
  formatSince,
  formatUptime,
  loadAverage,
  parseUptimeArgs,
  renderUptime,
} from '../../../src/shell/supplemental-commands/uptime-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A process record with only the fields the load average reads. */
function proc(startedAt: number, finishedAt: number | null): Process {
  return { startedAt, finishedAt } as unknown as Process;
}

async function run(args: string[], options: Parameters<typeof createUptimeCommand>[0] = {}) {
  const command = createUptimeCommand(options);
  return command.execute(args, mockCommandContext());
}

afterEach(() => {
  setPageLoadedAt(null);
});

describe('uptime registration', () => {
  it('is registered, so `uptime` is not "command not found"', () => {
    expect(createSupplementalCommands().map((command) => command.name)).toContain('uptime');
  });

  it('answers --version instead of 127', async () => {
    const result = await run(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^uptime \(SLICC\) \d/);
  });

  it('rejects an operand rather than ignoring it', async () => {
    const result = await run(['tomorrow']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unrecognized option 'tomorrow'");
  });
});

describe('readPageLoadedAt', () => {
  it('reports the page origin the kernel worker was handed', () => {
    setPageLoadedAt(1_700_000_000_000);
    expect(readPageLoadedAt()).toBe(1_700_000_000_000);
  });

  it('falls back to this realm’s own time origin when nothing was registered', () => {
    setPageLoadedAt(null);
    expect(readPageLoadedAt()).toBe(performance.timeOrigin);
  });

  it('ignores a nonsense value rather than reporting a bogus uptime', () => {
    setPageLoadedAt(Number.NaN);
    expect(readPageLoadedAt()).toBe(performance.timeOrigin);
    setPageLoadedAt(0);
    expect(readPageLoadedAt()).toBe(performance.timeOrigin);
  });
});

describe('uptime — elapsed time', () => {
  const bootedAt = new Date('2026-09-04T09:35:00').getTime();

  it('measures from the last page load, not from process start', async () => {
    const now = bootedAt + 2 * HOUR + 7 * MINUTE;
    const result = await run([], { now: () => now, bootedAt: () => bootedAt });
    expect(result.stdout).toContain('up 2:07,');
  });

  it('reads the registered page-load time when no seam is injected', async () => {
    setPageLoadedAt(bootedAt);
    const result = await run(['-s']);
    expect(result.stdout.trim()).toBe(formatSince(bootedAt));
  });

  it('prints the boot timestamp for --since', async () => {
    const result = await run(['--since'], { bootedAt: () => bootedAt });
    expect(result.stdout.trim()).toBe('2026-09-04 09:35:00');
  });

  it('prints words for --pretty', async () => {
    const now = bootedAt + DAY + 3 * HOUR + MINUTE;
    const result = await run(['--pretty'], { now: () => now, bootedAt: () => bootedAt });
    expect(result.stdout.trim()).toBe('up 1 day, 3 hours, 1 minute');
  });
});

describe('formatUptime', () => {
  it('prints minutes under an hour and h:mm above it', () => {
    expect(formatUptime(0)).toBe('0 min');
    expect(formatUptime(7 * MINUTE)).toBe('7 min');
    expect(formatUptime(HOUR + 5 * MINUTE)).toBe('1:05');
  });

  it('prints days separately, singular and plural', () => {
    expect(formatUptime(DAY + 4 * HOUR + 7 * MINUTE)).toBe('1 day, 4:07');
    expect(formatUptime(3 * DAY + 30 * MINUTE)).toBe('3 days, 30 min');
  });
});

describe('formatPretty', () => {
  it('omits the units that are zero', () => {
    expect(formatPretty(2 * HOUR)).toBe('up 2 hours');
    expect(formatPretty(DAY + MINUTE)).toBe('up 1 day, 1 minute');
  });

  it('falls back to seconds for a runtime that just booted', () => {
    expect(formatPretty(12_000)).toBe('up 12 seconds');
  });
});

describe('loadAverage', () => {
  const now = 10 * HOUR;
  const bootedAt = 0;

  it('is zero with nothing in the process table', () => {
    expect(loadAverage([], now, MINUTE, bootedAt)).toBe(0);
  });

  it('counts one process alive for the whole window as 1.00', () => {
    expect(loadAverage([proc(now - HOUR, null)], now, MINUTE, bootedAt)).toBeCloseTo(1, 5);
  });

  it('counts a process alive for half the window as 0.50', () => {
    const started = now - MINUTE / 2;
    expect(loadAverage([proc(started, null)], now, MINUTE, bootedAt)).toBeCloseTo(0.5, 5);
  });

  it('adds concurrent processes together', () => {
    const both = [proc(now - HOUR, null), proc(now - HOUR, null)];
    expect(loadAverage(both, now, MINUTE, bootedAt)).toBeCloseTo(2, 5);
  });

  it('ignores a process that finished before the window opened', () => {
    expect(loadAverage([proc(0, MINUTE)], now, MINUTE, bootedAt)).toBe(0);
  });

  it('counts only the part of a lifetime inside the window', () => {
    // Ran for 5 minutes ending 30 s ago: 30 s of it falls in the 1-minute window.
    const finished = now - 30_000;
    expect(loadAverage([proc(finished - 5 * MINUTE, finished)], now, MINUTE, bootedAt)).toBeCloseTo(
      0.5,
      5
    );
  });

  it('clamps the window to the uptime so a fresh boot is not diluted', () => {
    // Up for 10 s, busy the whole time: that is a load of 1, not 10/60.
    const freshNow = 10_000;
    expect(loadAverage([proc(0, null)], freshNow, MINUTE, 0)).toBeCloseTo(1, 5);
  });
});

describe('renderUptime', () => {
  it('prints clock, uptime, user count, and three load figures', () => {
    const bootedAt = new Date('2026-09-04T09:35:00').getTime();
    const now = bootedAt + 2 * HOUR + 7 * MINUTE;
    const line = renderUptime([proc(now - HOUR, null)], now, bootedAt);
    expect(line).toBe(' 11:42:00 up 2:07,  1 user,  load average: 1.00, 1.00, 1.00\n');
  });
});

describe('uptime — live process table', () => {
  it('reports load from the same ProcessManager `ps` reads', async () => {
    const pm = new ProcessManager();
    pm.spawn({ kind: 'shell', argv: ['sleep', '600'], owner: { kind: 'system' } });
    const bootedAt = Date.now() - HOUR;
    const result = await run([], { processManager: pm, bootedAt: () => bootedAt });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/load average: \d+\.\d\d, \d+\.\d\d, \d+\.\d\d/);
  });

  it('reports a zero load rather than failing when no kernel is wired', async () => {
    const result = await run([], { bootedAt: () => Date.now() - HOUR });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('load average: 0.00, 0.00, 0.00');
  });
});

describe('parseUptimeArgs', () => {
  it('maps the flags it knows', () => {
    expect(parseUptimeArgs([])).toBe('default');
    expect(parseUptimeArgs(['-p'])).toBe('pretty');
    expect(parseUptimeArgs(['--pretty'])).toBe('pretty');
    expect(parseUptimeArgs(['-s'])).toBe('since');
    expect(parseUptimeArgs(['--since'])).toBe('since');
    expect(parseUptimeArgs(['--help'])).toBe('help');
    expect(parseUptimeArgs(['-h'])).toBe('help');
    expect(parseUptimeArgs(['--version'])).toBe('version');
  });

  it('errors on anything else', () => {
    expect(parseUptimeArgs(['--load'])).toEqual({ error: "unrecognized option '--load'" });
  });
});

describe('uptime — through the real shell', () => {
  it('runs, is listed by `commands`, and is found by `which`', async () => {
    const vfs = await VirtualFS.create({ dbName: 'uptime-shell', wipe: true });
    const shell = new AlmostBashShellHeadless({ fs: vfs });
    const result = await shell.executeCommand('uptime');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/ up .*load average: /);
    expect((await shell.executeCommand('commands')).stdout).toContain('uptime');
    expect((await shell.executeCommand('which uptime')).exitCode).toBe(0);
  });
});
