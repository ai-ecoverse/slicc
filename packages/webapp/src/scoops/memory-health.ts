/**
 * P7 — enforced, verified memory maintenance.
 *
 * The memory report's `/mnt/kb` finding is that advisory maintenance does not
 * happen and a broken checker lies for the life of the store. So the health
 * check here is (a) run by the RUNTIME on a schedule — the kernel host calls
 * `scheduleMemoryHealthChecks` at boot, nobody has to ask a model to run it —
 * (b) persisted as numbers a human can sanity-check against reality
 * ({@link MEMORY_HEALTH_REPORT_PATH}), and (c) loud when its own tooling
 * breaks: a checker error is itself a reported failure, never a clean bill of
 * health, and an unreadable sessions index is a failure rather than "0
 * sessions, all fine".
 *
 * The `memory status --check` shell verb applies the same two lying-memory
 * rules on demand (`shell/` sits below `scoops/`, so it cannot import this
 * module; a cross-check test pins the two together) and prints the last
 * scheduled report so a human sees when the runtime last verified the system.
 */

import {
  type FrozenSessionIndexEntry,
  SESSIONS_INDEX_PATH,
} from '../transcript/frozen-archive-format.js';
import { EXTRA_CONE_HOME_ROOT, workspaceFor } from '../work-unit/descriptor.js';
import { PRIMARY_CONE_FOLDER } from '../work-unit/record.js';

/**
 * Durable report of the last scheduled check. Lives beside the curation
 * staging state; `memory status` prints it. Duplicated as a literal in
 * `shell/supplemental-commands/memory/run.ts` (layering) — a cross-check
 * test imports both.
 */
export const MEMORY_HEALTH_REPORT_PATH = '/sessions/.curation/health.json';

/** First check shortly after boot, once the boot catch-up has had its turn. */
export const HEALTH_CHECK_BOOT_DELAY_MS = 90_000;
/** Re-check daily while the kernel lives. */
export const HEALTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Minimal FS surface, structural so tests and remote clients both fit. */
export interface MemoryHealthFs {
  readFile(path: string, options?: { encoding?: 'utf-8' }): Promise<string | Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /**
   * Optional: lists `/cones` so archives of a cone that no longer exists are
   * not counted as lying (its memory file went with it). Without it every
   * cone named by an archive is checked.
   */
  readDir?(path: string): Promise<Array<{ name: string; type: string }>>;
}

/** One cone's side of the lying-memory check. */
export interface ConeMemoryHealth {
  folder: string;
  /** Archives from this cone that report successful curation. */
  curated: number;
  /** Memory file size in chars; null when missing. */
  chars: number | null;
}

export interface MemoryHealthReport {
  /** ISO timestamp of the check. */
  at: string;
  sessions: number;
  curation: { curated: number; failed: number; pending: number; skipped: number; none: number };
  /** Primary memory file size in chars; null when missing. */
  primaryMemoryChars: number | null;
  /** Every cone with curated archives, and the primary always. */
  cones: ConeMemoryHealth[];
  /** Human-readable failure lines; empty means healthy. */
  failures: string[];
}

/** Read a memory file's size; null when missing. Any other error propagates. */
async function memoryChars(fs: MemoryHealthFs, folder: string): Promise<number | null> {
  try {
    return (await readText(fs, workspaceFor({ parentJid: null, folder }).memoryPath)).length;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** Folders of the extra cones that exist, or null when the FS cannot list them. */
async function liveExtraCones(fs: MemoryHealthFs): Promise<Set<string> | null> {
  if (!fs.readDir) return null;
  try {
    const entries = await fs.readDir(EXTRA_CONE_HOME_ROOT);
    return new Set(entries.filter((e) => e.type === 'directory').map((e) => e.name));
  } catch {
    return new Set();
  }
}

function isEnoent(err: unknown): boolean {
  return (
    (err as { code?: string } | null)?.code === 'ENOENT' ||
    (err instanceof Error && err.message.includes('ENOENT'))
  );
}

async function readText(fs: MemoryHealthFs, path: string): Promise<string> {
  const raw = await fs.readFile(path, { encoding: 'utf-8' });
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

/**
 * Read the sessions index WITHOUT the swallow-to-`[]` behavior of
 * `readSessionsIndex`: for a health check, "the ledger cannot be read" and
 * "the ledger is empty" are opposite verdicts.
 */
async function readIndexStrict(
  fs: MemoryHealthFs
): Promise<{ entries: FrozenSessionIndexEntry[] } | { failure: string } | { fresh: true }> {
  let text: string;
  try {
    text = await readText(fs, SESSIONS_INDEX_PATH);
  } catch (err) {
    if (isEnoent(err)) return { fresh: true };
    return {
      failure: `sessions index unreadable at ${SESSIONS_INDEX_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { failure: `sessions index is not an array` };
    return { entries: parsed as FrozenSessionIndexEntry[] };
  } catch {
    return { failure: `sessions index at ${SESSIONS_INDEX_PATH} is not valid JSON` };
  }
}

function entryState(
  entry: FrozenSessionIndexEntry
): 'curated' | 'failed' | 'pending' | 'skipped' | 'none' {
  if (entry.memoryFailed !== undefined) return 'failed';
  if (entry.memoryPending) return 'pending';
  if (entry.memoryCuratedAt !== undefined) return 'curated';
  if (entry.memorySkipped) return 'skipped';
  return 'none';
}

/** Curated-archive counts per cone (the primary always present, maybe at 0). */
function curatedPerCone(entries: FrozenSessionIndexEntry[]): Map<string, number> {
  const counts = new Map<string, number>([[PRIMARY_CONE_FOLDER, 0]]);
  for (const entry of entries) {
    if (entryState(entry) !== 'curated') continue;
    // An archive's `cone` names the memory file its curation was supposed to
    // grow (absent = the primary).
    const folder = entry.cone ?? PRIMARY_CONE_FOLDER;
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return counts;
}

/**
 * Each cone's curated count beside its memory file size. A cone that was
 * dropped took its memory file with it — not a lie — so extra cones are
 * checked only when they still exist (when the FS can tell).
 */
async function collectConeHealth(
  fs: MemoryHealthFs,
  entries: FrozenSessionIndexEntry[]
): Promise<ConeMemoryHealth[]> {
  const live = await liveExtraCones(fs);
  const cones: ConeMemoryHealth[] = [];
  for (const [folder, curated] of curatedPerCone(entries)) {
    if (folder !== PRIMARY_CONE_FOLDER && live && !live.has(folder)) continue;
    cones.push({ folder, curated, chars: await memoryChars(fs, folder) });
  }
  return cones;
}

/**
 * The "memory system that lies" shape, per cone: curation reports success
 * but the file that cone's user believes is accumulating memory is missing
 * or empty. Checking only the primary would flag a healthy extra-cone setup
 * with no primary memory, and miss an extra cone whose file vanished.
 */
function lyingMemoryFailures(cones: ConeMemoryHealth[]): string[] {
  return cones
    .filter((cone) => cone.curated > 0 && (cone.chars ?? 0) === 0)
    .map((cone) =>
      cone.folder === PRIMARY_CONE_FOLDER
        ? `${cone.curated} archive(s) report successful curation but the primary memory file is missing or empty`
        : `${cone.curated} archive(s) from cone "${cone.folder}" report successful curation but its memory file is missing or empty`
    );
}

/** Run the two lying-memory checks plus the tooling self-check. Never throws. */
export async function runMemoryHealthCheck(
  fs: MemoryHealthFs,
  now: () => Date = () => new Date()
): Promise<MemoryHealthReport> {
  const report: MemoryHealthReport = {
    at: now().toISOString(),
    sessions: 0,
    curation: { curated: 0, failed: 0, pending: 0, skipped: 0, none: 0 },
    primaryMemoryChars: null,
    cones: [],
    failures: [],
  };
  try {
    const index = await readIndexStrict(fs);
    if ('failure' in index) {
      report.failures.push(index.failure);
      return report;
    }
    const entries = 'entries' in index ? index.entries : [];
    report.sessions = entries.length;
    for (const entry of entries) report.curation[entryState(entry)]++;

    try {
      report.cones = await collectConeHealth(fs, entries);
    } catch (err) {
      report.failures.push(
        `memory file unreadable: ${err instanceof Error ? err.message : String(err)}`
      );
      return report;
    }
    report.primaryMemoryChars =
      report.cones.find((cone) => cone.folder === PRIMARY_CONE_FOLDER)?.chars ?? null;

    if (report.curation.failed > 0) {
      report.failures.push(
        `${report.curation.failed} archive(s) whose last curation attempt failed`
      );
    }
    report.failures.push(...lyingMemoryFailures(report.cones));
  } catch (err) {
    // Criterion (c): a broken checker is a failure, never silence.
    report.failures.push(
      `health check itself failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return report;
}

/** Run one scheduled check and persist the report; returns it for the caller's log. */
export async function runScheduledMemoryHealthCheck(
  fs: MemoryHealthFs,
  now?: () => Date
): Promise<MemoryHealthReport> {
  const report = await runMemoryHealthCheck(fs, now);
  await fs.mkdir('/sessions/.curation', { recursive: true });
  await fs.writeFile(MEMORY_HEALTH_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export interface MemoryHealthLogger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error?(msg: string, ...rest: unknown[]): void;
}

export interface ScheduleMemoryHealthOptions {
  log: MemoryHealthLogger;
  bootDelayMs?: number;
  intervalMs?: number;
}

/**
 * Schedule the recurring runtime check: once shortly after boot, then daily
 * for as long as the kernel lives. Returns a cancel function. A failing
 * report — including a failure OF the checker — logs at error level (warn
 * when the logger has no error), so the console shows red rather than a
 * silent green boot; the durable numbers land in
 * {@link MEMORY_HEALTH_REPORT_PATH} either way.
 */
export function scheduleMemoryHealthChecks(
  fs: MemoryHealthFs,
  options: ScheduleMemoryHealthOptions
): () => void {
  const { log } = options;
  const tick = async (): Promise<void> => {
    try {
      const report = await runScheduledMemoryHealthCheck(fs);
      if (report.failures.length > 0) {
        const loud = log.error ?? log.warn.bind(log);
        loud('memory health check FAILED', {
          failures: report.failures,
          report: MEMORY_HEALTH_REPORT_PATH,
        });
      } else {
        log.info('memory health check ok', {
          sessions: report.sessions,
          curation: report.curation,
        });
      }
    } catch (err) {
      // Persisting the report failed — the one failure the report file
      // cannot carry, so the log line is the loud path.
      const loud = log.error ?? log.warn.bind(log);
      loud('memory health check could not persist its report', err);
    }
  };
  const timeout = setTimeout(() => {
    void tick();
  }, options.bootDelayMs ?? HEALTH_CHECK_BOOT_DELAY_MS);
  const interval = setInterval(() => {
    void tick();
  }, options.intervalMs ?? HEALTH_CHECK_INTERVAL_MS);
  return () => {
    clearTimeout(timeout);
    clearInterval(interval);
  };
}
