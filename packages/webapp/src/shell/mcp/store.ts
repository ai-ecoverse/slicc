/**
 * MCP server store — read/write `/workspace/.mcp/servers.json` via the
 * global `VirtualFS` (same IndexedDB as the rest of the app).
 *
 * This module is the canonical source for the on-disk MCP layout. Other
 * modules (e.g. `provider-store-access.ts`) re-export the auth-related
 * helpers from here so there is exactly one reader/writer of the file.
 */

import { createLogger } from '../../core/logger.js';
import { GLOBAL_FS_DB_NAME } from '../../fs/global-db.js';
import { FsError } from '../../fs/types.js';
import type { McpAuthEntry, McpServerAuthRecord, McpServerEntry, McpServersFile } from './types.js';

const log = createLogger('mcp-store');

/** Absolute VFS path of the persisted server registry. */
export const MCP_STORE_PATH = '/workspace/.mcp/servers.json';
const MCP_DIR = '/workspace/.mcp';

const CURRENT_VERSION = 1;

let cachedFsModule: typeof import('../../fs/index.js') | null = null;
/**
 * Cached VFS instance. We keep a single instance per dbName so that
 * sequential `setServer`/`getServer` calls observe each other's writes
 * without waiting for LightningFS's debounced superblock flush — a fresh
 * `VirtualFS.create()` reads from IDB at construction, which can race
 * pending writes from a previous instance.
 */
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

function normalize(raw: unknown): McpServersFile {
  if (!raw || typeof raw !== 'object') return emptyFile();
  const obj = raw as Partial<McpServersFile> & { servers?: unknown };
  const version = typeof obj.version === 'number' ? obj.version : CURRENT_VERSION;
  const servers: Record<string, McpServerEntry> = {};
  if (obj.servers && typeof obj.servers === 'object') {
    for (const [name, entry] of Object.entries(obj.servers as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as McpServerEntry & Record<string, unknown>;
      if (typeof e.url !== 'string') continue;
      servers[name] = e;
    }
  }
  return { version, servers };
}

/** Read the entire `servers.json`. Returns an empty file if missing/invalid. */
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
    log.warn('Failed to read servers.json', {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyFile();
  }
}

/** Atomically replace the entire `servers.json`. */
export async function writeServersFile(
  file: McpServersFile,
  injectedFs?: MinimalFs | null
): Promise<void> {
  const fs = await openFs(injectedFs);
  await fs.mkdir(MCP_DIR, { recursive: true });
  const payload: McpServersFile = {
    version: file.version || CURRENT_VERSION,
    servers: file.servers ?? {},
  };
  await fs.writeFile(MCP_STORE_PATH, JSON.stringify(payload, null, 2));
}

/** Read a single server entry by name (or null if missing). */
export async function getServer(
  name: string,
  injectedFs?: MinimalFs | null
): Promise<McpServerEntry | null> {
  const file = await readServersFile(injectedFs);
  return file.servers[name] ?? null;
}

/** Upsert a server entry. Merges with the existing entry if present. */
export async function setServer(
  name: string,
  entry: McpServerEntry,
  injectedFs?: MinimalFs | null
): Promise<McpServerEntry> {
  const file = await readServersFile(injectedFs);
  const merged: McpServerEntry = { ...file.servers[name], ...entry };
  file.servers[name] = merged;
  await writeServersFile(file, injectedFs);
  return merged;
}

/** Delete a server entry. Returns true if anything was removed. */
export async function deleteServer(name: string, injectedFs?: MinimalFs | null): Promise<boolean> {
  const file = await readServersFile(injectedFs);
  if (!(name in file.servers)) return false;
  delete file.servers[name];
  await writeServersFile(file, injectedFs);
  return true;
}

/** List all server entries keyed by name. */
export async function listServers(
  injectedFs?: MinimalFs | null
): Promise<Record<string, McpServerEntry>> {
  const file = await readServersFile(injectedFs);
  return file.servers;
}

// ── Auth-block accessors (used by provider-store-access.ts) ─────────

/** Joined `{ name, serverUrl, auth }` view for a single server, or null. */
export async function readMcpAuthEntry(name: string): Promise<McpServerAuthRecord | null> {
  const entry = await getServer(name);
  if (!entry?.url || !entry.auth?.clientId) return null;
  return { name, serverUrl: entry.url, auth: entry.auth };
}

/** Joined view for every server that carries a complete `auth` block. */
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

// ── Test-only hooks ─────────────────────────────────────────────────

/** Reset the cached fs module + instance so tests can swap implementations. */
export function testOnlyResetStoreCache(): void {
  cachedFsModule = null;
  cachedFs = null;
}

/** Inject a stub fs module (for tests that bypass IndexedDB). */
export function testOnlySetFsModule(mod: typeof import('../../fs/index.js') | null): void {
  cachedFsModule = mod;
  cachedFs = null;
}
