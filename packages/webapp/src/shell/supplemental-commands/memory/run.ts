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
 *   status [--json] [--check]   files, budget, curation ledger, last scheduled
 *                               health check; --check exits non-zero on
 *                               failed/lying state (P7's on-demand twin — the
 *                               runtime schedules the same checks via
 *                               scoops/memory-health.ts)
 *   log [--limit N]             per-archive curation ledger, newest first
 *   curate [...]                run a curator pass now, over the seam
 *   dream [...]                 run a memory-dreamer refactoring pass
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

type MemoryPassOutcome =
  | { ok: true; report: string }
  | { ok: false; reason: string; legacyFallbackSafe: boolean };

/** Mirror of `MemorySeam` (`scoops/memory-curation-seam.ts`). */
interface MemorySeamLike {
  curate(request: {
    sessionArchivePath: string;
    sessionCount: number;
    cone?: { folder: string };
  }): Promise<MemoryPassOutcome>;
  dream(request: { cone?: { folder: string } }): Promise<MemoryPassOutcome>;
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
  status [--json] [--check]  Memory files, budget, the curation ledger, and the
                             runtime's last scheduled health check; --check
                             exits non-zero when the ledger shows a failed
                             curation or curated-but-empty memory
  log [--limit N]            Per-archive curation ledger, newest first (default 20)
  curate [--archive <file>] [--cone <folder>]
                             Run a memory-curator pass now — the same pass the
                             session freezer runs (default: newest archive, into
                             the cone it was frozen from)
  dream [--cone <folder>] [--all] [--wait]
                             Run a memory-dreamer pass: consolidate a cone's
                             memory file (merge duplicates, drop superseded and
                             stale facts, land under budget). --all dreams every
                             cone that has a memory file; default is detached —
                             --wait blocks and prints each pass's report

Files:
  /workspace/CLAUDE.md            The primary cone's memory file
  /cones/<folder>/CLAUDE.md       An extra cone's memory file
  /shared/MEMORY.md               Curator instructions + config (frontmatter)
  /shared/DREAMING.md             Dreamer instructions + config (frontmatter)
  /sessions/index.json            Per-archive curation ledger (memoryPending,
                                  memoryCuratedAt, memoryFailed, memorySkipped)
  /sessions/.curation/health.json Last scheduled runtime health check (boot +
                                  daily; written by the kernel, not a model)

Examples:
  memory status --check
  memory log --limit 5
  memory curate --archive 2026-09-11T08-30-00Z-fix-build.md
  memory dream --all
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
  return found && typeof found.curate === 'function' && typeof found.dream === 'function'
    ? found
    : null;
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

/**
 * Resolve a cone folder against the cones that actually exist. A `--cone`
 * value crosses the memory seam as a storage folder and becomes a path on
 * the far side (`/cones/<folder>/CLAUDE.md`), written through the
 * unrestricted shared VFS after normalization — so `../../shared`, a typo or
 * a dropped cone must stop HERE, before a curator or dreamer is pointed at a
 * file outside any real cone. (The gelatiere, a restricted scoop, has
 * `memory` on its allow-list.)
 */
async function resolveConeFolder(
  fs: VirtualFS,
  value: string
): Promise<{ folder: string } | { error: string }> {
  const folders = await listConeFolders(fs);
  if (folders.includes(value)) return { folder: value };
  return { error: `unknown cone "${value}" (cones: ${folders.join(', ')})` };
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
  const resolved = await resolveConeFolder(fs, parsed.values.get('--cone') ?? PRIMARY_CONE_FOLDER);
  if ('error' in resolved) return fail(resolved.error);
  const path = memoryPathFor(resolved.folder);
  const content = await readMemoryFile(fs, path);
  if (content === null) return fail(`no memory file at ${path}`);
  return ok(content.endsWith('\n') || content === '' ? content : `${content}\n`);
}

interface ConeMemoryRow {
  folder: string;
  path: string;
  chars: number | null;
}

/**
 * Where the runtime's scheduled health check persists its last report.
 * Duplicate of `MEMORY_HEALTH_REPORT_PATH` in `scoops/memory-health.ts` —
 * shell cannot import scoops; a cross-check test pins the two together.
 */
const HEALTH_REPORT_PATH = '/sessions/.curation/health.json';

interface ScheduledCheckSummary {
  at: string;
  failures: string[];
}

interface MemoryStatusReport {
  memoryV2: boolean;
  sessions: number;
  budgetChars: number;
  cones: ConeMemoryRow[];
  curation: { curated: number; failed: number; pending: number; skipped: number; none: number };
  checks: string[];
  /** The runtime's last scheduled health check (P7); null when it never ran. */
  scheduledCheck: ScheduledCheckSummary | null;
}

async function readScheduledCheck(fs: VirtualFS): Promise<ScheduledCheckSummary | null> {
  const raw = await readMemoryFile(fs, HEALTH_REPORT_PATH);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { at?: unknown; failures?: unknown };
    if (typeof parsed.at !== 'string' || !Array.isArray(parsed.failures)) return null;
    return { at: parsed.at, failures: parsed.failures.map(String) };
  } catch {
    return null;
  }
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
  const curatedPerCone = new Map<string, number>();
  for (const entry of index) {
    const state = entryState(entry);
    curation[state]++;
    if (state === 'curated') {
      const folder = entry.cone ?? PRIMARY_CONE_FOLDER;
      curatedPerCone.set(folder, (curatedPerCone.get(folder) ?? 0) + 1);
    }
  }

  const checks: string[] = [];
  if (curation.failed > 0) {
    checks.push(
      `${curation.failed} archive(s) whose last curation attempt failed — see \`memory log\``
    );
  }
  // The "memory system that lies" shape, per cone: curation reports success,
  // but the file that cone's user believes is accumulating memory is missing
  // or empty. Archives from a cone that no longer exists are not a lie — its
  // memory file went with it.
  for (const cone of cones) {
    const curated = curatedPerCone.get(cone.folder) ?? 0;
    if (curated === 0 || (cone.chars ?? 0) > 0) continue;
    checks.push(
      cone.folder === PRIMARY_CONE_FOLDER
        ? `${curated} archive(s) report successful curation but the primary memory file is missing or empty`
        : `${curated} archive(s) from cone "${cone.folder}" report successful curation but its memory file (${cone.path}) is missing or empty`
    );
  }
  return {
    memoryV2: !(await memoryV2Off()),
    sessions: index.length,
    budgetChars: computeBudget(index.length),
    cones,
    curation,
    checks,
    scheduledCheck: await readScheduledCheck(fs),
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
  // The runtime's scheduled check (P7) — proof the system is being verified
  // by code on a schedule, not only when someone asks.
  if (report.scheduledCheck) {
    const { at, failures } = report.scheduledCheck;
    output +=
      failures.length > 0
        ? `Scheduled:  ${at} — ${failures.length} FAILURE(S), see ${HEALTH_REPORT_PATH}\n`
        : `Scheduled:  ${at} — ok\n`;
  } else {
    output += 'Scheduled:  never ran (starts ~90s after boot with memory-v2 on)\n';
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
  // The pass rewrites ONE cone's memory file. Default to the cone the archive
  // was frozen from (`entry.cone`, absent on legacy entries = the primary):
  // folding an extra cone's session into /workspace/CLAUDE.md would
  // contaminate the primary's memory while leaving the owning cone untouched.
  const explicit = parsed.values.get('--cone');
  const wantedFolder = explicit ?? entry.cone ?? PRIMARY_CONE_FOLDER;
  const resolved = await resolveConeFolder(fs, wantedFolder);
  if ('error' in resolved) {
    return fail(
      explicit
        ? resolved.error
        : `archive "${entry.filename}" was frozen from cone "${wantedFolder}", which no longer exists — pass --cone <folder> to curate it into another cone`
    );
  }
  const { folder } = resolved;
  const result = await host.curate({
    sessionArchivePath: `/sessions/${entry.filename}`,
    sessionCount: index.length,
    ...(folder !== PRIMARY_CONE_FOLDER ? { cone: { folder } } : {}),
  });
  if (!result.ok) return fail(`curation failed: ${result.reason}`);
  const report = result.report.trim();
  return ok(`Curated ${entry.filename}\n${report ? `${report}\n` : ''}`);
}

/**
 * Where a dream pass records its outcome. The path shape is
 * `dreamStateKey()`'s (`scoops/memory-dreaming.ts`) — duplicated here because
 * shell cannot import scoops; a cross-check test pins the two together.
 */
function dreamStatusPath(folder: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `/sessions/.curation/dream-${today}-${folder}.md/status.json`;
}

/** Which cones a `memory dream` invocation refactors. */
async function dreamTargets(
  fs: VirtualFS,
  all: boolean,
  cone: string | undefined
): Promise<{ folders: string[] } | { error: string }> {
  if (!all) {
    const resolved = await resolveConeFolder(fs, cone ?? PRIMARY_CONE_FOLDER);
    return 'error' in resolved ? resolved : { folders: [resolved.folder] };
  }
  // Every cone that actually has a memory file — a cone that never
  // accumulated memory has nothing to consolidate.
  const folders: string[] = [];
  for (const folder of await listConeFolders(fs)) {
    if ((await readMemoryFile(fs, memoryPathFor(folder))) !== null) folders.push(folder);
  }
  if (folders.length === 0)
    return { error: 'no cone has a memory file yet — nothing to dream about' };
  return { folders };
}

async function handleDream(args: string[], fs: VirtualFS): Promise<CommandResult> {
  const parsed = parseKnownFlags(args, { value: ['--cone'], bool: ['--all', '--wait'] });
  if ('error' in parsed) return fail(parsed.error);
  const all = parsed.bools.has('--all');
  const cone = parsed.values.get('--cone');
  if (all && cone !== undefined) return fail('--all and --cone are mutually exclusive');
  const host = seam();
  if (!host) return fail(NO_SEAM);

  const selected = await dreamTargets(fs, all, cone);
  if ('error' in selected) return fail(selected.error);
  const { folders } = selected;

  const request = (folder: string) =>
    host.dream(folder === PRIMARY_CONE_FOLDER ? {} : { cone: { folder } });

  if (!parsed.bools.has('--wait')) {
    // Detached, but one cone AFTER another: every dreamer may write the shared
    // wiki (`/shared/wiki/index.md`, `log.md`, the same page), and those
    // writes are not staged like the memory draft — parallel dreamers would
    // race on last-write-wins. The outcome lands in each pass's status.json.
    void folders.reduce(
      (chain, folder) =>
        chain
          .then(() => request(folder))
          .then(
            () => undefined,
            () => undefined
          ),
      Promise.resolve()
    );
    const lines = folders.map((folder) => `  ${folder.padEnd(14)}${dreamStatusPath(folder)}`);
    return ok(
      `Dreaming started for ${folders.length} cone(s); outcomes land in:\n${lines.join('\n')}\n`
    );
  }

  let output = '';
  let failed = 0;
  for (const folder of folders) {
    const result = await request(folder);
    if (result.ok) {
      const report = result.report.trim();
      output += `${folder}: dreamed\n${report ? `${indent(report)}\n` : ''}`;
    } else {
      failed++;
      output += `${folder}: FAILED — ${result.reason}\n`;
    }
  }
  return { stdout: output, stderr: '', exitCode: failed > 0 ? 1 : 0 };
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
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
    case 'dream':
      return handleDream(rest, options.fs);
    default:
      return fail(`unknown command: ${subcommand}\n${HELP}`);
  }
}
