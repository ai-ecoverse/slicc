import { GLOBAL_FS_DB_NAME } from '../../fs/global-db.js';
import { FsError } from '../../fs/types.js';
import type { InstalledPluginEntry, PluginsFile } from './types.js';

export const PLUGINS_STORE_PATH = '/workspace/.plugins/plugins.json';
const PLUGINS_DIR = '/workspace/.plugins';

const CURRENT_VERSION = 1;

interface MinimalFs {
  readFile: (path: string, options?: { encoding?: 'utf-8' | 'binary' }) => Promise<unknown>;
  writeFile: (path: string, content: string | Uint8Array) => Promise<void>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
}

let cachedFs: { instance: unknown; dbName: string } | null = null;

async function openFs(injected?: MinimalFs | null): Promise<MinimalFs> {
  if (injected) return injected;
  if (cachedFs && cachedFs.dbName === GLOBAL_FS_DB_NAME) {
    return cachedFs.instance as MinimalFs;
  }
  const { VirtualFS } = await import('../../fs/index.js');
  const instance = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
  cachedFs = { instance, dbName: GLOBAL_FS_DB_NAME };
  return instance as MinimalFs;
}

export function testOnlyResetPluginsStoreCache(): void {
  cachedFs = null;
}

function emptyFile(): PluginsFile {
  return { version: CURRENT_VERSION, plugins: {} };
}

interface UntrustedPluginsFile {
  readonly version?: unknown;
  readonly plugins?: unknown;
}

interface UntrustedPluginsMap {
  readonly [pluginName: string]: unknown;
}

interface UntrustedInstalledPluginEntry {
  readonly root?: unknown;
  readonly version?: unknown;
  readonly description?: unknown;
  readonly installedAt?: unknown;
  readonly mcpServerNames?: unknown;
  readonly source?: unknown;
}

function isPlainObject(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEntry(raw: unknown): InstalledPluginEntry | null {
  if (!isPlainObject(raw)) return null;
  const entry = raw as UntrustedInstalledPluginEntry;
  if (typeof entry.root !== 'string') return null;
  return entry as unknown as InstalledPluginEntry;
}

function normalize(raw: unknown): PluginsFile {
  if (!isPlainObject(raw)) return emptyFile();
  const obj = raw as UntrustedPluginsFile;
  const version = typeof obj.version === 'number' ? obj.version : CURRENT_VERSION;
  const plugins: Record<string, InstalledPluginEntry> = {};
  if (isPlainObject(obj.plugins)) {
    for (const [name, entry] of Object.entries(obj.plugins as UntrustedPluginsMap)) {
      const normalized = normalizeEntry(entry);
      if (normalized) plugins[name] = normalized;
    }
  }
  return { version, plugins };
}

export async function readPluginsFile(injectedFs?: MinimalFs | null): Promise<PluginsFile> {
  try {
    const fs = await openFs(injectedFs);
    const content = (await fs.readFile(PLUGINS_STORE_PATH, { encoding: 'utf-8' })) as string;
    try {
      return normalize(JSON.parse(content));
    } catch {
      return emptyFile();
    }
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return emptyFile();
    throw err;
  }
}

export async function writePluginsFile(
  file: PluginsFile,
  injectedFs?: MinimalFs | null
): Promise<void> {
  const fs = await openFs(injectedFs);
  await fs.mkdir(PLUGINS_DIR, { recursive: true });
  const payload = normalize({
    version: file.version || CURRENT_VERSION,
    plugins: file.plugins ?? {},
  });
  await fs.writeFile(PLUGINS_STORE_PATH, JSON.stringify(payload, null, 2));
}

export async function getInstalledPlugin(
  name: string,
  injectedFs?: MinimalFs | null
): Promise<InstalledPluginEntry | null> {
  const file = await readPluginsFile(injectedFs);
  return file.plugins[name] ?? null;
}

export async function setInstalledPlugin(
  name: string,
  entry: InstalledPluginEntry,
  injectedFs?: MinimalFs | null
): Promise<void> {
  const file = await readPluginsFile(injectedFs);
  file.plugins[name] = entry;
  await writePluginsFile(file, injectedFs);
}

export async function deleteInstalledPlugin(
  name: string,
  injectedFs?: MinimalFs | null
): Promise<boolean> {
  const file = await readPluginsFile(injectedFs);
  if (!(name in file.plugins)) return false;
  delete file.plugins[name];
  await writePluginsFile(file, injectedFs);
  return true;
}

export async function listInstalledPlugins(
  injectedFs?: MinimalFs | null
): Promise<Record<string, InstalledPluginEntry>> {
  const file = await readPluginsFile(injectedFs);
  return file.plugins;
}
