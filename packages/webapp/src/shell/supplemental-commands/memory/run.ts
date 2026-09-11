/**
 * `memory` — the shell surface of SLICC's durable cone memory (the body;
 * `../memory-command.ts` is the thin registration that lazy-loads this file).
 *
 * Durable memory is one file per cone (`/workspace/CLAUDE.md` for the
 * primary, `/cones/<folder>/CLAUDE.md` for extras), rewritten by the
 * memory-curator scoop after a chat freezes. This command is how anyone —
 * the user, a cone, a scheduled check — inspects that system and pokes it:
 *
 *   show [--cone <folder>]      the cone's memory file, verbatim
 *   status [--json] [--check]   files, budget, curation ledger; --check exits
 *                               non-zero on failed/lying state (P7 seed)
 *   log [--limit N]             per-archive curation ledger, newest first
 *   curate [...]                run a curator pass now, over the seam
 *
 * `shell/` sits below `scoops/`, so the pass itself comes through the seam
 * the kernel host publishes on `globalThis.__slicc_memory` (mirrored
 * structurally here, like `__slicc_gelatiere`). Everything else is plain
 * reads of `/sessions/index.json` and the memory files.
 */

import { computeBudget } from '../../../base/memory-budget.js';
import type { VirtualFS } from '../../../fs/index.js';
import {
  type FrozenSessionIndexEntry,
  readSessionsIndex,
} from '../../../transcript/frozen-archive-format.js';
import { EXTRA_CONE_HOME_ROOT, workspaceFor } from '../../../work-unit/descriptor.js';
import { PRIMARY_CONE_FOLDER } from '../../../work-unit/record.js';
import type { MemoryCommandOptions } from '../memory-command.js';
import { parseKnownFlags } from '../subcommand-flags.js';
import { isHelpRequest } from '../subcommand-help.js';

type CommandResult = { stdout: string; stderr: string; exitCode: number };

/** Mirror of `MemorySeam` (`scoops/memory-curation-seam.ts`). */
interface MemorySeamLike {
  curate(request: {
    sessionArchivePath: string;
    sessionCount: number;
    cone?: { folder: string };
  }): Promise<
    { ok: true; report: string } | { ok: false; reason: string; legacyFallbackSafe: boolean }
  >;
}

interface MemoryGlobals {
  __slicc_memory?: MemorySeamLike;
}

const HELP = `usage: memory <command> [options]

Durable cone memory: one file per cone, rewritten by the memory-curator
scoop after a chat freezes. This command inspects that system and pokes it.
All commands except \`status\` require the memory-v2 feature flag.

Commands:
  show [--cone <folder>]     Print the cone's memory file (default: primary cone)
  status [--json] [--check]  Memory files, budget, and the curation ledger;
                             --check exits non-zero when the ledger shows a
                             failed curation or curated-but-empty memory
  log [--limit N]            Per-archive curation ledger, newest first (default 20)
  curate [--archive <file>] [--cone <folder>]
                             Run a memory-curator pass now — the same pass the
                             session freezer runs (default: newest archive)

Files:
  /workspace/CLAUDE.md            The primary cone's memory file
  /cones/<folder>/CLAUDE.md       An extra cone's memory file
  /shared/MEMORY.md               Curator instructions + config (frontmatter)
  /sessions/index.json            Per-archive curation ledger (memoryPending,
                                  memoryCuratedAt, memoryFailed, memorySkipped)

Examples:
  memory status --check
  memory log --limit 5
  memory curate --archive 2026-09-11T08-30-00Z-fix-build.md
`;

const VALUE_FLAGS = ['--cone', '--archive', '--limit'] as const;

function ok(stdout: string): CommandResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(message: string): CommandResult {
  return { stdout: '', stderr: `memory: ${message}\n`, exitCode: 1 };
}

function seam(): MemorySeamLike | null {
  const found = (globalThis as unknown as MemoryGlobals).__slicc_memory;
  return found && typeof found.curate === 'function' ? found : null;
}

async function memoryV2Off(): Promise<boolean> {
  const { isMemoryV2Enabled } = await import('../../../transcript/memory-v2-flag.js');
  return !isMemoryV2Enabled();
}

/** Read a memory file; null when missing. */
async function readMemoryFile(fs: VirtualFS, path: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path, { encoding: 'utf-8' });
    return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    return null;
  }
}

/** The primary cone plus every `/cones/<folder>` home that exists. */
async function listConeFolders(fs: VirtualFS): Promise<string[]> {
  const folders = [PRIMARY_CONE_FOLDER];
  try {
    const entries = await fs.readDir(EXTRA_CONE_HOME_ROOT);
    for (const entry of entries) {
      if (entry.type === 'directory') folders.push(entry.name);
    }
  } catch {
    // No extra cones yet.
  }
  return folders;
}

function memoryPathFor(folder: string): string {
  return workspaceFor({ parentJid: null, folder }).memoryPath;
}

/** The curation ledger state a sessions-index entry is in. */
function entryState(
  entry: FrozenSessionIndexEntry
): 'curated' | 'failed' | 'pending' | 'skipped' | 'none' {
  if (entry.memoryFailed !== undefined) return 'failed';
  if (entry.memoryPending) return 'pending';
  if (entry.memoryCuratedAt !== undefined) return 'curated';
  if (entry.memorySkipped) return 'skipped';
  return 'none';
}

async function handleShow(args: string[], fs: VirtualFS): Promise<CommandResult> {
  const parsed = parseKnownFlags(args, { value: ['--cone'] });
  if ('error' in parsed) return fail(parsed.error);
  const folder = parsed.values.get('--cone') ?? PRIMARY_CONE_FOLDER;
  const path = memoryPathFor(folder);
  const content = await readMemoryFile(fs, path);
  if (content === null) return fail(`no memory file at ${path}`);
  return ok(content.endsWith('\n') || content === '' ? content : `${content}\n`);
}

interface ConeMemoryRow {
  folder: string;
  path: string;
  chars: number | null;
}

interface MemoryStatusReport {
  memoryV2: boolean;
  sessions: number;
  budgetChars: number;
  cones: ConeMemoryRow[];
  curation: { curated: number; failed: number; pending: number; skipped: number; none: number };
  checks: string[];
}

async function buildStatusReport(fs: VirtualFS): Promise<MemoryStatusReport> {
  const index = await readSessionsIndex(fs);
  const cones: ConeMemoryRow[] = [];
  for (const folder of await listConeFolders(fs)) {
    const path = memoryPathFor(folder);
    const content = await readMemoryFile(fs, path);
    cones.push({ folder, path, chars: content === null ? null : content.length });
  }
  const curation = { curated: 0, failed: 0, pending: 0, skipped: 0, none: 0 };
  for (const entry of index) curation[entryState(entry)]++;

  const checks: string[] = [];
  if (curation.failed > 0) {
    checks.push(
      `${curation.failed} archive(s) whose last curation attempt failed — see \`memory log\``
    );
  }
  // The "memory system that lies" shape: curation reports success, but the
  // file the user believes is accumulating memory is missing or empty.
  const primary = cones.find((cone) => cone.folder === PRIMARY_CONE_FOLDER);
  if (curation.curated > 0 && (primary?.chars ?? 0) === 0) {
    checks.push(
      `${curation.curated} archive(s) report successful curation but the primary memory file is missing or empty`
    );
  }
  return {
    memoryV2: !(await memoryV2Off()),
    sessions: index.length,
    budgetChars: computeBudget(index.length),
    cones,
    curation,
    checks,
  };
}

async function handleStatus(args: string[], fs: VirtualFS): Promise<CommandResult> {
  const parsed = parseKnownFlags(args, { bool: ['--json', '--check'] });
  if ('error' in parsed) return fail(parsed.error);
  const report = await buildStatusReport(fs);
  const failed = parsed.bools.has('--check') && report.checks.length > 0;
  if (parsed.bools.has('--json')) {
    return { stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: '', exitCode: failed ? 1 : 0 };
  }
  let output = `Memory v2:  ${report.memoryV2 ? 'ON' : 'OFF — curation surfaces beyond the freezer pass are disabled'}\n`;
  output += `Sessions:   ${report.sessions} archived (memory budget ${report.budgetChars} chars)\n`;
  output += 'Memory files:\n';
  for (const cone of report.cones) {
    const size = cone.chars === null ? 'missing' : `${cone.chars} chars`;
    output += `  ${cone.folder.padEnd(14)}${cone.path}  (${size})\n`;
  }
  const { curated, failed: failedCount, pending, skipped, none } = report.curation;
  output += `Curation:   ${curated} curated, ${failedCount} failed, ${pending} pending, ${skipped} skipped, ${none} unmarked\n`;
  if (report.checks.length > 0) {
    output += 'Health:\n';
    for (const check of report.checks) output += `  FAIL  ${check}\n`;
  } else {
    output += 'Health:     ok\n';
  }
  return { stdout: output, stderr: '', exitCode: failed ? 1 : 0 };
}

const DEFAULT_LOG_LIMIT = 20;

async function handleLog(args: string[], fs: VirtualFS): Promise<CommandResult> {
  const parsed = parseKnownFlags(args, { value: ['--limit'] });
  if ('error' in parsed) return fail(parsed.error);
  const rawLimit = parsed.values.get('--limit');
  const limit = rawLimit === undefined ? DEFAULT_LOG_LIMIT : Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit <= 0) return fail(`--limit must be a positive number`);
  const index = await readSessionsIndex(fs);
  if (index.length === 0) return ok('no archived sessions yet\n');
  const rows = [...index]
    .sort((a, b) => (a.frozenAt < b.frozenAt ? 1 : -1))
    .slice(0, limit)
    .map((entry) => {
      const state = entryState(entry);
      const detail =
        state === 'failed'
          ? `  (${entry.memoryFailed})`
          : state === 'curated'
            ? `  (at ${entry.memoryCuratedAt})`
            : '';
      return `${entry.frozenAt}  ${state.padEnd(8)}${entry.filename}${detail}`;
    });
  return ok(`${rows.join('\n')}\n`);
}

const NO_SEAM = 'kernel host has not booted yet — try again in a moment';

async function handleCurate(args: string[], fs: VirtualFS): Promise<CommandResult> {
  const parsed = parseKnownFlags(args, { value: ['--archive', '--cone'] });
  if ('error' in parsed) return fail(parsed.error);
  const host = seam();
  if (!host) return fail(NO_SEAM);
  const index = await readSessionsIndex(fs);
  const wanted = parsed.values.get('--archive');
  let entry: FrozenSessionIndexEntry | undefined;
  if (wanted === undefined) {
    entry = [...index].sort((a, b) => (a.frozenAt < b.frozenAt ? 1 : -1))[0];
    if (!entry) return fail('no archived sessions to curate — freeze a chat first');
  } else {
    entry = index.find((candidate) => candidate.filename === wanted);
    if (!entry) return fail(`no archive named "${wanted}" in /sessions/index.json`);
  }
  const folder = parsed.values.get('--cone');
  const result = await host.curate({
    sessionArchivePath: `/sessions/${entry.filename}`,
    sessionCount: index.length,
    ...(folder && folder !== PRIMARY_CONE_FOLDER ? { cone: { folder } } : {}),
  });
  if (!result.ok) return fail(`curation failed: ${result.reason}`);
  const report = result.report.trim();
  return ok(`Curated ${entry.filename}\n${report ? `${report}\n` : ''}`);
}

/** The command body: `args` after the `memory` word, plus the shared FS. */
export async function runMemory(
  args: string[],
  options: MemoryCommandOptions
): Promise<CommandResult> {
  const subcommand = args[0];
  if (!subcommand || isHelpRequest(args, { valueFlags: VALUE_FLAGS })) return ok(HELP);
  const rest = args.slice(1);
  // `status` always answers (it reports the flag state itself); every other
  // verb is a Memory v2 surface and stays dark with the flag off.
  if (subcommand !== 'status' && (await memoryV2Off())) {
    return fail('Memory v2 is off — enable the "memory-v2" feature flag to use this command');
  }
  switch (subcommand) {
    case 'show':
      return handleShow(rest, options.fs);
    case 'status':
      return handleStatus(rest, options.fs);
    case 'log':
      return handleLog(rest, options.fs);
    case 'curate':
      return handleCurate(rest, options.fs);
    default:
      return fail(`unknown command: ${subcommand}\n${HELP}`);
  }
}
