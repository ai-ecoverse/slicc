/**
 * JSH Discovery — scan an ordered list of search roots for `.jsh` shell
 * script files and build a map of command names (basename without
 * extension) to VFS paths.
 *
 * The roots come from the shell's `$PATH` (#2085): command lookup is
 * "read these directories", not "walk the entire VFS". Earlier roots win
 * a basename conflict; within a root, `walk()` order decides. Each root
 * is scanned recursively — a skill's commands live wherever the skill
 * keeps them (`/workspace/skills/<skill>/scripts/…`) — but vendored
 * `node_modules` and dot-directories never register commands.
 */

import type { FileContent, ReadFileOptions } from '../fs/types.js';

/** Minimal filesystem interface needed for JSH discovery and script reading. */
export interface JshDiscoveryFS {
  exists(path: string): Promise<boolean>;
  walk(path: string): AsyncGenerator<string>;
  readFile(path: string, options?: ReadFileOptions): Promise<FileContent>;
}

/**
 * Search roots baked into the default `$PATH`, in priority order. These
 * cover every location the platform itself puts `.jsh` commands in:
 * skills (`createDefaultSkills`, installed skills) and the MCP alias
 * shims. `/workspace/bin` and `/shared/bin` are the blessed homes for
 * ad-hoc user commands — anything elsewhere needs a `PATH` entry
 * (`export PATH="$PATH:/my/tools"` in `~/.profile`).
 */
export const DEFAULT_JSH_SEARCH_ROOTS = [
  '/workspace/skills',
  '/workspace/.mcp/aliases',
  '/workspace/bin',
  '/shared/bin',
];

/**
 * The default `$PATH` a shell starts with. `/usr/bin` is the synthetic
 * registry directory (`vfs-adapter.ts`); the rest are `.jsh` search roots.
 */
export const DEFAULT_SHELL_PATH = `/usr/bin:${DEFAULT_JSH_SEARCH_ROOTS.join(':')}`;

/**
 * Directories whose contents never register as commands even when they sit
 * under a search root: vendored packages and hidden state. `/workspace/.mcp/
 * aliases` is itself a dot-path root, so the dot rule applies only BELOW a
 * root, never to the root itself.
 */
const PRUNED_SEGMENT = /\/(node_modules|\.[^/]+)\//;

/**
 * Derive `.jsh` search roots from a `$PATH` value. `/usr/bin` and `/bin`
 * are the interpreter's synthetic registry dirs, not scan roots. Order is
 * preserved (PATH precedence), duplicates and empties dropped.
 */
export function pathToScanRoots(pathValue: string | undefined): string[] {
  const roots: string[] = [];
  for (const entry of (pathValue ?? '').split(':')) {
    const trimmed = entry.trim().replace(/\/+$/, '');
    if (!trimmed || trimmed === '/usr/bin' || trimmed === '/bin') continue;
    if (!trimmed.startsWith('/')) continue;
    if (!roots.includes(trimmed)) roots.push(trimmed);
  }
  return roots;
}

/**
 * Discover `.jsh` files under the given search roots and return a map of
 * command name → VFS path. Earlier roots win a basename conflict.
 *
 * Defaults to {@link DEFAULT_JSH_SEARCH_ROOTS}; callers with a live shell
 * env derive the list via {@link pathToScanRoots} so `export PATH=…`
 * (interactive or from `~/.profile`) extends command lookup.
 */
export async function discoverJshCommands(
  fs: JshDiscoveryFS,
  roots: readonly string[] = DEFAULT_JSH_SEARCH_ROOTS
): Promise<Map<string, string>> {
  const commands = new Map<string, string>();
  for (const root of roots) {
    if (await fs.exists(root).catch(() => false)) {
      await scanDir(fs, root, commands);
    }
  }
  return commands;
}

/** Walk a directory and collect .jsh files into the map (first wins). */
async function scanDir(
  fs: JshDiscoveryFS,
  root: string,
  commands: Map<string, string>
): Promise<void> {
  const rootPrefix = root.replace(/\/+$/, '');
  for await (const filePath of fs.walk(root)) {
    if (!filePath.endsWith('.jsh')) continue;
    if (PRUNED_SEGMENT.test(filePath.slice(rootPrefix.length))) continue;
    const name = commandName(filePath);
    if (!commands.has(name)) {
      commands.set(name, filePath);
    }
  }
}

/** Extract command name from a .jsh file path (basename minus extension). */
function commandName(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.endsWith('.jsh') ? base.slice(0, -4) : base;
}
