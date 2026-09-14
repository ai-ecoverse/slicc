import {
  type FrozenSessionIndexEntry,
  SESSIONS_INDEX_PATH,
} from '../transcript/frozen-archive-format.js';
import { EXTRA_CONE_HOME_ROOT, workspaceFor } from '../work-unit/descriptor.js';
import { PRIMARY_CONE_FOLDER } from '../work-unit/record.js';

export const MEMORY_HEALTH_REPORT_PATH = '/sessions/.curation/health.json';

export const HEALTH_CHECK_BOOT_DELAY_MS = 90_000;

export const HEALTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MemoryHealthFs {
  readFile(path: string, options?: { encoding?: 'utf-8' }): Promise<string | Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;

  readDir?(path: string): Promise<Array<{ name: string; type: string }>>;
}

export interface ConeMemoryHealth {
  folder: string;

  curated: number;

  chars: number | null;
}

export interface MemoryHealthReport {
  at: string;
  sessions: number;
  curation: { curated: number; failed: number; pending: number; skipped: number; none: number };

  primaryMemoryChars: number | null;

  cones: ConeMemoryHealth[];

  failures: string[];
}

async function memoryChars(fs: MemoryHealthFs, folder: string): Promise<number | null> {
  try {
    return (await readText(fs, workspaceFor({ parentJid: null, folder }).memoryPath)).length;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

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

function curatedPerCone(entries: FrozenSessionIndexEntry[]): Map<string, number> {
  const counts = new Map<string, number>([[PRIMARY_CONE_FOLDER, 0]]);
  for (const entry of entries) {
    if (entryState(entry) !== 'curated') continue;

    const folder = entry.cone ?? PRIMARY_CONE_FOLDER;
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return counts;
}

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

function lyingMemoryFailures(cones: ConeMemoryHealth[]): string[] {
  return cones
    .filter((cone) => cone.curated > 0 && (cone.chars ?? 0) === 0)
    .map((cone) =>
      cone.folder === PRIMARY_CONE_FOLDER
        ? `${cone.curated} archive(s) report successful curation but the primary memory file is missing or empty`
        : `${cone.curated} archive(s) from cone "${cone.folder}" report successful curation but its memory file is missing or empty`
    );
}

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
    report.failures.push(
      `health check itself failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return report;
}

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
