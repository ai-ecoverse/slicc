import {
  JSHD_DIR,
  JSHD_LOG_DIR,
  type JshdRestartPolicy,
  type JshdUnitRecord,
  unitLogPath,
  unitRecordPath,
} from './types.js';

/** Minimal FS surface used by unit records and logs. */
export interface JshdFs {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string | Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile?(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm?(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir?(path: string): Promise<string[]>;
  readDir?(path: string): Promise<Array<string | { name: string }>>;
}

const RESTART_POLICIES = new Set<JshdRestartPolicy>(['always', 'on-failure', 'no']);

function asText(content: string | Uint8Array): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

export async function ensureJshdDirs(fs: JshdFs): Promise<void> {
  await fs.mkdir(JSHD_DIR, { recursive: true });
  await fs.mkdir(JSHD_LOG_DIR, { recursive: true });
}

export async function writeUnitRecord(fs: JshdFs, record: JshdUnitRecord): Promise<void> {
  await ensureJshdDirs(fs);
  await fs.writeFile(unitRecordPath(record.name), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readUnitRecord(fs: JshdFs, name: string): Promise<JshdUnitRecord | null> {
  const path = unitRecordPath(name);
  if (!(await fs.exists(path))) return null;
  try {
    const parsed: unknown = JSON.parse(asText(await fs.readFile(path)));
    return parseUnitRecord(parsed);
  } catch {
    return null;
  }
}

export async function deleteUnitRecord(fs: JshdFs, name: string): Promise<void> {
  const path = unitRecordPath(name);
  if (await fs.exists(path)) await fs.rm?.(path);
  const logPath = unitLogPath(name);
  if (await fs.exists(logPath)) await fs.rm?.(logPath);
}

export async function listUnitRecords(fs: JshdFs): Promise<JshdUnitRecord[]> {
  if (!(await fs.exists(JSHD_DIR))) return [];
  const names = await listDirNames(fs, JSHD_DIR);
  const records: JshdUnitRecord[] = [];
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    const record = await readUnitRecord(fs, file.slice(0, -'.json'.length));
    if (record) records.push(record);
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

export async function appendUnitLog(fs: JshdFs, name: string, chunk: string): Promise<void> {
  if (!chunk) return;
  await ensureJshdDirs(fs);
  const path = unitLogPath(name);
  if (fs.appendFile) {
    await fs.appendFile(path, chunk);
    return;
  }
  const existing = (await fs.exists(path)) ? asText(await fs.readFile(path)) : '';
  await fs.writeFile(path, existing + chunk);
}

export async function readUnitLog(fs: JshdFs, name: string): Promise<string> {
  const path = unitLogPath(name);
  if (!(await fs.exists(path))) return '';
  return asText(await fs.readFile(path));
}

interface UnitRecordJson {
  name?: unknown;
  argv?: unknown;
  cwd?: unknown;
  createdAt?: unknown;
  enabled?: unknown;
  restart?: unknown;
  env?: unknown;
}

function parseUnitRecord(value: unknown): JshdUnitRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as UnitRecordJson;
  if (typeof rec.name !== 'string' || !Array.isArray(rec.argv)) return null;
  if (typeof rec.cwd !== 'string' || typeof rec.createdAt !== 'string') return null;
  if (typeof rec.enabled !== 'boolean') return null;
  if (typeof rec.restart !== 'string' || !RESTART_POLICIES.has(rec.restart as JshdRestartPolicy)) {
    return null;
  }
  const argv = rec.argv.filter((item): item is string => typeof item === 'string');
  if (argv.length === 0) return null;
  return {
    name: rec.name,
    argv,
    cwd: rec.cwd,
    env: readStringMap(rec.env),
    restart: rec.restart as JshdRestartPolicy,
    enabled: rec.enabled,
    createdAt: rec.createdAt,
  };
}

function readStringMap(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return env;
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') env[key] = val;
  }
  return env;
}

async function listDirNames(fs: JshdFs, path: string): Promise<string[]> {
  try {
    if (fs.readdir) return await fs.readdir(path);
    if (fs.readDir) {
      const entries = await fs.readDir(path);
      return entries.map((entry) => (typeof entry === 'string' ? entry : entry.name));
    }
  } catch {
    return [];
  }
  return [];
}
