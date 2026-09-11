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
import { workspaceFor } from '../work-unit/descriptor.js';
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
}

export interface MemoryHealthReport {
  /** ISO timestamp of the check. */
  at: string;
  sessions: number;
  curation: { curated: number; failed: number; pending: number; skipped: number; none: number };
  /** Primary memory file size in chars; null when missing. */
  primaryMemoryChars: number | null;
  /** Human-readable failure lines; empty means healthy. */
  failures: string[];
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
      const primary = await readText(
        fs,
        workspaceFor({ parentJid: null, folder: PRIMARY_CONE_FOLDER }).memoryPath
      );
      report.primaryMemoryChars = primary.length;
    } catch (err) {
      if (!isEnoent(err)) {
        report.failures.push(
          `primary memory file unreadable: ${err instanceof Error ? err.message : String(err)}`
        );
        return report;
      }
    }

    if (report.curation.failed > 0) {
      report.failures.push(
        `${report.curation.failed} archive(s) whose last curation attempt failed`
      );
    }
    // The "memory system that lies" shape: curation reports success but the
    // file the user believes is accumulating memory is missing or empty.
    if (report.curation.curated > 0 && (report.primaryMemoryChars ?? 0) === 0) {
      report.failures.push(
        `${report.curation.curated} archive(s) report successful curation but the primary memory file is missing or empty`
      );
    }
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
