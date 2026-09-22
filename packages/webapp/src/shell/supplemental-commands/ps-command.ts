import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { Process, ProcessManager, ProcessStatus } from '../../kernel/process-manager.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

export interface PsCommandOptions {
  processManager?: ProcessManager;
}

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

const SCOOP_COLUMN_WIDTH = 10;

interface ScoopColumn {
  full: boolean;

  width: number;
}

const PS_BOOL_FLAGS = ['-a', '-A', '-e', '--all', '-T', '--tree'] as const;

const PS_VALUE_FLAGS = ['-o', '--columns'] as const;

interface KernelGlobals {
  __slicc_pm?: unknown;
}

export function createPsCommand(options: PsCommandOptions = {}): Command {
  return defineCommand('ps', async (args) => {
    if (isHelpRequest(args, { valueFlags: PS_VALUE_FLAGS })) {
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

    const flagParse = parseKnownFlags(args, { bool: PS_BOOL_FLAGS, value: PS_VALUE_FLAGS });
    if ('error' in flagParse) {
      return {
        stdout: '',
        stderr: `ps: ${flagParse.error}\n`,
        exitCode: flagParse.error.startsWith('unknown flag:') ? 1 : 2,
      };
    }

    if (flagParse.positionals.length > 0) {
      return {
        stdout: '',
        stderr: `ps: unrecognized argument '${flagParse.positionals[0]}'\n`,
        exitCode: 2,
      };
    }

    let columns: Column[] = DEFAULT_COLUMNS;
    const tree = flagParse.bools.has('-T') || flagParse.bools.has('--tree');

    const showAll =
      flagParse.bools.has('-a') ||
      flagParse.bools.has('-A') ||
      flagParse.bools.has('-e') ||
      flagParse.bools.has('--all');
    const rawColumns = flagParse.values.get('-o') ?? flagParse.values.get('--columns');
    if (rawColumns !== undefined) {
      const parsed = parseColumns(rawColumns);
      if (parsed instanceof Error) {
        return { stdout: '', stderr: `ps: ${parsed.message}\n`, exitCode: 2 };
      }
      columns = parsed;
    }

    const all = pm.list().sort((a, b) => a.pid - b.pid);
    const procs = showAll
      ? all
      : all.filter((p) => p.status === 'running' || p.status === 'pending');
    const ordered = tree ? orderAsTree(procs) : procs.map((p) => ({ proc: p, depth: 0 }));
    const scoop = scoopColumnFor(
      columns,
      ordered.map(({ proc }) => proc),
      rawColumns !== undefined
    );
    const rows = ordered.map(({ proc, depth }) => renderRow(proc, columns, depth, tree, scoop));
    const header = renderHeader(columns, scoop);
    return {
      stdout: [header, ...rows].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  });
}

function lookupGlobalPm(): ProcessManager | null {
  const pm = (globalThis as KernelGlobals).__slicc_pm;
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

function scoopColumnFor(columns: Column[], procs: Process[], explicit: boolean): ScoopColumn {
  const full = explicit && columns.includes('scoop');
  if (!full) return { full: false, width: SCOOP_COLUMN_WIDTH };
  let width = 'SCOOP'.length;
  for (const proc of procs) width = Math.max(width, scoopIdentity(proc).length);
  return { full: true, width };
}

function renderHeader(columns: Column[], scoop: ScoopColumn): string {
  return columns.map((c) => columnHeader(c, scoop)).join('  ');
}

function columnHeader(c: Column, scoop: ScoopColumn): string {
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
      return 'SCOOP'.padEnd(scoop.width);
    case 'command':
      return 'COMMAND';
  }
}

function renderRow(
  proc: Process,
  columns: Column[],
  depth: number,
  tree: boolean,
  scoop: ScoopColumn
): string {
  return columns.map((c) => renderCell(proc, c, depth, tree, scoop)).join('  ');
}

function renderCell(
  proc: Process,
  col: Column,
  depth: number,
  tree: boolean,
  scoop: ScoopColumn
): string {
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
      return formatScoop(proc, scoop);
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

function scoopIdentity(proc: Process): string {
  if (proc.owner.kind === 'cone') return 'cone';
  if (proc.owner.kind === 'system') return 'system';
  if (proc.owner.kind === 'jshd') return 'jshd';
  return proc.owner.scoopJid ?? 'scoop';
}

function formatScoop(proc: Process, scoop: ScoopColumn): string {
  const identity = scoopIdentity(proc);
  const shown = scoop.full ? identity : identity.slice(0, scoop.width);
  return shown.padEnd(scoop.width);
}

function formatCommand(proc: Process, depth: number, tree: boolean): string {
  const prefix = tree && depth > 0 ? '  '.repeat(depth - 1) + '└─ ' : '';
  const text = proc.argv.length === 0 ? `[${proc.kind}]` : proc.argv.map(shellQuote).join(' ');
  const truncated = text.length > COMMAND_MAX ? text.slice(0, COMMAND_MAX - 1) + '…' : text;
  return prefix + truncated;
}

function shellQuote(arg: string): string {
  if (arg === '') return "''";

  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  if (arg.includes('"') && !arg.includes("'")) {
    return `'${arg}'`;
  }
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

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
  KIND          scoop-turn | tool | shell | jsh | py | net
  STAT          R running, S pending, Z exited, K killed
  START         hh:mm:ss when the process spawned
  SCOOP         cone | system | jshd | scoop jid. The default
                table keeps a 10-character prefix. Naming scoop
                in -o prints the jid in full.
  COMMAND       argv (truncated; tree mode draws connectors)

Examples:
  ps                  live processes only
  ps -a               every process, including the dead
  ps -T               live tree
  ps -a -T            full tree
  ps -o pid,kind,stat      just three columns
  ps -o scoop,stat,pid     full scoop jid, with STAT and PID
`,
    stderr: '',
    exitCode: 0,
  };
}
