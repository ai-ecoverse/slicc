/**
 * `ps` — list processes tracked by the kernel `ProcessManager`.
 *
 * Reads from a manager supplied via DI (the kernel-host
 * boot wires it through `createSupplementalCommands`) or, as a
 * fallback for shell scripts and any code that can't accept
 * constructor injection, from `globalThis.__slicc_pm`.
 *
 * Default: `PID PPID STAT START SCOOP COMMAND` for every process,
 * sorted by pid ascending.
 *
 * Flags:
 *   `-e`             show all processes (default — included for
 *                    POSIX compatibility; omitting it does the
 *                    same thing today)
 *   `-T`             tree mode — indent children under their
 *                    parents using ASCII connectors
 *   `-o COL,COL,…`   column selector. Supported columns:
 *                      pid, ppid, kind, stat, start, scoop, command
 *                    Default order is `pid,ppid,stat,start,scoop,command`.
 *   `--help`         usage
 *
 * The `STAT` column maps:
 *   running  → R
 *   pending  → S
 *   exited   → Z (zombie — not reaped)
 *   killed   → K
 *
 * `SCOOP` shows `cone` / `<scoopJid prefix>` / `system` derived
 * from `Process.owner`. `COMMAND` is `argv.join(' ')` truncated
 * to a configurable width (80 chars by default).
 */

import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import type { Process, ProcessManager, ProcessStatus } from '../../kernel/process-manager.js';

export interface PsCommandOptions {
  /**
   * Inject a `ProcessManager` directly. When omitted, the command
   * looks up `globalThis.__slicc_pm` at exec time. Tests pass an
   * explicit instance.
   */
  processManager?: ProcessManager;
}

/** Standard column set, in default order. */
const ALL_COLUMNS = ['pid', 'ppid', 'kind', 'stat', 'start', 'scoop', 'command'] as const;
type Column = (typeof ALL_COLUMNS)[number];
const DEFAULT_COLUMNS: Column[] = ['pid', 'ppid', 'stat', 'start', 'scoop', 'command'];

const STAT_MAP: Record<ProcessStatus, string> = {
  running: 'R',
  pending: 'S',
  exited: 'Z',
  killed: 'K',
};

const COMMAND_MAX = 80;

export function createPsCommand(options: PsCommandOptions = {}): Command {
  return defineCommand('ps', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return psHelp();
    }

    const pm = options.processManager ?? lookupGlobalPm();
    if (!pm) {
      return {
        stdout: '',
        stderr: 'ps: no process manager available in this runtime\n',
        exitCode: 1,
      };
    }

    let columns: Column[] = DEFAULT_COLUMNS;
    let tree = false;
    // By default `ps` shows only live processes (running / pending).
    // Exited/killed entries aren't reaped — they linger so
    // post-mortem `ps` after `kill` can still show the exit code —
    // but listing them by default is noisy. `-a`/`-A`/`-e` includes
    // them.
    let showAll = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-a' || a === '-A' || a === '-e' || a === '--all') {
        showAll = true;
        continue;
      }
      if (a === '-T' || a === '--tree') {
        tree = true;
        continue;
      }
      if (a === '-o' || a.startsWith('--columns=') || a.startsWith('-o=')) {
        const raw = a.startsWith('-o=')
          ? a.slice(3)
          : a.startsWith('--columns=')
            ? a.slice('--columns='.length)
            : args[++i];
        if (typeof raw !== 'string') {
          return { stdout: '', stderr: `ps: -o requires an argument\n`, exitCode: 2 };
        }
        const parsed = parseColumns(raw);
        if (parsed instanceof Error) {
          return { stdout: '', stderr: `ps: ${parsed.message}\n`, exitCode: 2 };
        }
        columns = parsed;
        continue;
      }
      return { stdout: '', stderr: `ps: unrecognized argument '${a}'\n`, exitCode: 2 };
    }

    const all = pm.list().sort((a, b) => a.pid - b.pid);
    const procs = showAll
      ? all
      : all.filter((p) => p.status === 'running' || p.status === 'pending');
    const ordered = tree ? orderAsTree(procs) : procs.map((p) => ({ proc: p, depth: 0 }));
    const rows = ordered.map(({ proc, depth }) => renderRow(proc, columns, depth, tree));
    const header = renderHeader(columns);
    return {
      stdout: [header, ...rows].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function lookupGlobalPm(): ProcessManager | null {
  const g = globalThis as Record<string, unknown>;
  const pm = g.__slicc_pm;
  return pm instanceof Object && typeof (pm as ProcessManager).list === 'function'
    ? (pm as ProcessManager)
    : null;
}

function parseColumns(raw: string): Column[] | Error {
  const tokens = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    return new Error('-o requires at least one column');
  }
  const out: Column[] = [];
  for (const t of tokens) {
    if (!ALL_COLUMNS.includes(t as Column)) {
      return new Error(`unknown column '${t}'; supported: ${ALL_COLUMNS.join(', ')}`);
    }
    out.push(t as Column);
  }
  return out;
}

function renderHeader(columns: Column[]): string {
  return columns.map((c) => columnHeader(c)).join('  ');
}

function columnHeader(c: Column): string {
  switch (c) {
    case 'pid':
      return 'PID'.padStart(5);
    case 'ppid':
      return 'PPID'.padStart(5);
    case 'kind':
      return 'KIND'.padEnd(10);
    case 'stat':
      return 'STAT';
    case 'start':
      return 'START';
    case 'scoop':
      return 'SCOOP'.padEnd(10);
    case 'command':
      return 'COMMAND';
  }
}

function renderRow(proc: Process, columns: Column[], depth: number, tree: boolean): string {
  return columns.map((c) => renderCell(proc, c, depth, tree)).join('  ');
}

function renderCell(proc: Process, col: Column, depth: number, tree: boolean): string {
  switch (col) {
    case 'pid':
      return String(proc.pid).padStart(5);
    case 'ppid':
      return String(proc.ppid).padStart(5);
    case 'kind':
      return proc.kind.padEnd(10);
    case 'stat':
      return STAT_MAP[proc.status];
    case 'start':
      return formatStart(proc.startedAt);
    case 'scoop':
      return formatScoop(proc).padEnd(10);
    case 'command':
      return formatCommand(proc, depth, tree);
  }
}

function formatStart(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatScoop(proc: Process): string {
  if (proc.owner.kind === 'cone') return 'cone';
  if (proc.owner.kind === 'system') return 'system';
  // scoop — show short jid prefix to keep the column tight.
  return proc.owner.scoopJid?.slice(0, 10) ?? 'scoop';
}

function formatCommand(proc: Process, depth: number, tree: boolean): string {
  const prefix = tree && depth > 0 ? '  '.repeat(depth - 1) + '└─ ' : '';
  const text = proc.argv.length === 0 ? `[${proc.kind}]` : proc.argv.map(shellQuote).join(' ');
  const truncated = text.length > COMMAND_MAX ? text.slice(0, COMMAND_MAX - 1) + '…' : text;
  return prefix + truncated;
}

/**
 * Shell-style quote an argv element for human display in the
 * COMMAND column. Three cases, matching POSIX practice:
 *   1. Bare-acceptable charset → bare.
 *   2. Contains `"` but no `'` → wrap in single quotes (no
 *      escaping needed inside `'…'`). This is the readability
 *      win — `bash 'bash -c "date && sleep 8 && date"'` instead
 *      of `bash "bash -c \"date && sleep 8 && date\""`.
 *   3. Otherwise → wrap in double quotes with internal `"` and
 *      `\` escaped (handles strings that contain `'`).
 *
 * Strings containing both `'` and `"` use case 3 with `"`
 * escaping — rare in practice; the result is still parseable.
 *
 * This is for display only — `cmdline` files in /proc keep the
 * raw NUL-separated form (procfs convention).
 */
function shellQuote(arg: string): string {
  if (arg === '') return "''";
  // Bare-acceptable charset: alnum + a few common path / shell
  // primitives that are unambiguous unquoted.
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  if (arg.includes('"') && !arg.includes("'")) {
    return `'${arg}'`;
  }
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Walk the process list as a tree rooted at orphans (processes
 * whose `ppid` isn't another tracked pid). Emits parents before
 * children. Cycles can't form because pids are monotonic and
 * `ppid` was set at spawn time, but as a defense-in-depth the
 * walker tracks visited pids and skips repeats.
 */
function orderAsTree(procs: Process[]): Array<{ proc: Process; depth: number }> {
  const byPid = new Map<number, Process>();
  for (const p of procs) byPid.set(p.pid, p);
  const childrenOf = new Map<number, Process[]>();
  const orphans: Process[] = [];
  for (const p of procs) {
    if (byPid.has(p.ppid)) {
      const arr = childrenOf.get(p.ppid) ?? [];
      arr.push(p);
      childrenOf.set(p.ppid, arr);
    } else {
      orphans.push(p);
    }
  }
  const out: Array<{ proc: Process; depth: number }> = [];
  const visited = new Set<number>();
  const walk = (p: Process, depth: number): void => {
    if (visited.has(p.pid)) return;
    visited.add(p.pid);
    out.push({ proc: p, depth });
    const children = childrenOf.get(p.pid) ?? [];
    for (const child of children.sort((a, b) => a.pid - b.pid)) {
      walk(child, depth + 1);
    }
  };
  for (const orphan of orphans.sort((a, b) => a.pid - b.pid)) {
    walk(orphan, 0);
  }
  return out;
}

function psHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `Usage: ps [-a] [-T] [-o col[,col…]]

List processes tracked by the kernel.

By default ps shows only LIVE processes (running / pending).
Exited and killed entries linger in the table so post-mortem
\`ps\` after \`kill\` can still show their exit code, but listing
them every time is noisy — pass \`-a\` to include them.

Flags:
  -a, -A, -e, --all   include exited / killed processes
  -T, --tree          indent children under parents
  -o COLS             column selector (comma-separated):
                        pid, ppid, kind, stat, start, scoop, command
  -h, --help          show this help

Columns (default: pid,ppid,stat,start,scoop,command):
  PID/PPID      process / parent pid
  KIND          scoop-turn | tool | shell | jsh | net | preemptive
  STAT          R running, S pending, Z exited, K killed
  START         hh:mm:ss when the process spawned
  SCOOP         cone | system | <scoopJid prefix>
  COMMAND       argv (truncated; tree mode draws connectors)

Examples:
  ps                  live processes only
  ps -a               every process, including the dead
  ps -T               live tree
  ps -a -T            full tree
  ps -o pid,kind,stat just three columns
`,
    stderr: '',
    exitCode: 0,
  };
}
