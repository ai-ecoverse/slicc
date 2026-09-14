import { createLogger } from '../../base/logger.js';
import { GLOBAL_FS_DB_NAME } from '../../fs/global-db.js';
import { FsError } from '../../fs/types.js';
import type { McpAuthEntry, McpServerAuthRecord, McpServerEntry, McpServersFile } from './types.js';

const log = createLogger('mcp-store');

export const MCP_STORE_PATH = '/workspace/.mcp/servers.json';
const MCP_DIR = '/workspace/.mcp';

const CURRENT_VERSION = 1;

let cachedFsModule: typeof import('../../fs/index.js') | null = null;

let cachedFs: { instance: unknown; dbName: string } | null = null;

interface MinimalFs {
  readFile: (path: string, options?: { encoding?: 'utf-8' | 'binary' }) => Promise<unknown>;
  writeFile: (path: string, content: string | Uint8Array) => Promise<void>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
}

async function loadFsModule(): Promise<typeof import('../../fs/index.js')> {
  if (!cachedFsModule) {
    cachedFsModule = await import('../../fs/index.js');
  }
  return cachedFsModule;
}

async function openFs(injected?: MinimalFs | null): Promise<MinimalFs> {
  if (injected) return injected;
  if (cachedFs && cachedFs.dbName === GLOBAL_FS_DB_NAME) {
    return cachedFs.instance as MinimalFs;
  }
  const { VirtualFS } = await loadFsModule();
  const instance = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
  cachedFs = { instance, dbName: GLOBAL_FS_DB_NAME };
  return instance as MinimalFs;
}

function emptyFile(): McpServersFile {
  return { version: CURRENT_VERSION, servers: {} };
}

interface UntrustedMcpServersFile {
  readonly version?: unknown;
  readonly servers?: unknown;
}

interface UntrustedMcpServersMap {
  readonly [serverName: string]: unknown;
}

interface UntrustedMcpServerEntry {
  url?: unknown;
  sessionId?: unknown;
  protocolVersion?: unknown;
  headers?: unknown;
  tools?: unknown;
  apps?: unknown;
  addedAt?: unknown;
  lastRefreshedAt?: unknown;
  auth?: unknown;
  pluginOrigin?: unknown;
}

function isPlainObject(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEntry(raw: unknown): McpServerEntry | null {
  if (!isPlainObject(raw)) return null;

  const entry: UntrustedMcpServerEntry = { ...(raw as UntrustedMcpServerEntry) };
  if (typeof entry.url !== 'string') return null;
  delete entry.sessionId;
  return entry as unknown as McpServerEntry;
}

function normalize(raw: unknown): McpServersFile {
  if (!isPlainObject(raw)) return emptyFile();
  const obj = raw as UntrustedMcpServersFile;
  const version = typeof obj.version === 'number' ? obj.version : CURRENT_VERSION;
  const servers: Record<string, McpServerEntry> = {};
  if (isPlainObject(obj.servers)) {
    for (const [name, entry] of Object.entries(obj.servers as UntrustedMcpServersMap)) {
      const normalized = normalizeEntry(entry);
      if (normalized) servers[name] = normalized;
    }
  }
  return { version, servers };
}

export async function readServersFile(injectedFs?: MinimalFs | null): Promise<McpServersFile> {
  try {
    const fs = await openFs(injectedFs);
    const content = (await fs.readFile(MCP_STORE_PATH, { encoding: 'utf-8' })) as string;
    try {
      return normalize(JSON.parse(content));
    } catch (err) {
      log.warn('servers.json is not valid JSON; treating as empty', {
        error: err instanceof Error ? err.message : String(err),
      });
      return emptyFile();
    }
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return emptyFile();
    throw err;
  }
}

export async function writeServersFile(
  file: McpServersFile,
  injectedFs?: MinimalFs | null
): Promise<void> {
  const fs = await openFs(injectedFs);
  await fs.mkdir(MCP_DIR, { recursive: true });
  const payload = normalize({
    version: file.version || CURRENT_VERSION,
    servers: file.servers ?? {},
  });
  await fs.writeFile(MCP_STORE_PATH, JSON.stringify(payload, null, 2));
}

export async function getServer(
  name: string,
  injectedFs?: MinimalFs | null
): Promise<McpServerEntry | null> {
  const file = await readServersFile(injectedFs);
  return file.servers[name] ?? null;
}

export async function setServer(
  name: string,
  entry: McpServerEntry,
  injectedFs?: MinimalFs | null
): Promise<McpServerEntry> {
  const file = await readServersFile(injectedFs);
  const merged = normalizeEntry({ ...file.servers[name], ...entry });
  if (!merged) throw new Error('MCP server entry requires a URL');
  file.servers[name] = merged;
  await writeServersFile(file, injectedFs);
  return merged;
}

export async function deleteServer(name: string, injectedFs?: MinimalFs | null): Promise<boolean> {
  const file = await readServersFile(injectedFs);
  if (!(name in file.servers)) return false;
  delete file.servers[name];
  await writeServersFile(file, injectedFs);
  return true;
}

export async function listServers(
  injectedFs?: MinimalFs | null
): Promise<Record<string, McpServerEntry>> {
  const file = await readServersFile(injectedFs);
  return file.servers;
}

export async function readMcpAuthEntry(name: string): Promise<McpServerAuthRecord | null> {
  const entry = await getServer(name);
  if (!entry?.url || !entry.auth?.clientId) return null;
  return { name, serverUrl: entry.url, auth: entry.auth };
}

export async function readMcpAuthEntries(): Promise<McpServerAuthRecord[]> {
  const servers = await listServers();
  const out: McpServerAuthRecord[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry?.url || !entry.auth?.clientId) continue;
    out.push({ name, serverUrl: entry.url, auth: entry.auth });
  }
  return out;
}

export type { McpAuthEntry, McpServerAuthRecord, McpServerEntry, McpServersFile, MinimalFs };

export function testOnlyResetStoreCache(): void {
  cachedFsModule = null;
  cachedFs = null;
}

export function testOnlySetFsModule(mod: typeof import('../../fs/index.js') | null): void {
  cachedFsModule = mod;
  cachedFs = null;
}
