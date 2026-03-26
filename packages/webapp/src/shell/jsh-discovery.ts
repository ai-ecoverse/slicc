/**
 * JSH Discovery — scan VirtualFS for `.jsh` shell script files and
 * build a map of command names (basename without extension) to VFS paths.
 *
 * The first `.jsh` file found for a given basename wins (deterministic
 * via walk() order). Skills directories (`/workspace/skills/`) are scanned
 * first to give them priority.
 */

import type { FileContent, ReadFileOptions } from '../fs/types.js';

/** Minimal filesystem interface needed for JSH discovery and script reading. */
export interface JshDiscoveryFS {
  exists(path: string): Promise<boolean>;
  walk(path: string): AsyncGenerator<string>;
  readFile(path: string, options?: ReadFileOptions): Promise<FileContent>;
}

/** Priority roots to scan first (in order). */
const PRIORITY_ROOTS = ['/workspace/skills'];

/**
 * Discover all `.jsh` files in the VFS and return a map of
 * command name → VFS path. First occurrence of a basename wins.
 * Priority roots are scanned before the general `/` walk.
 */
export async function discoverJshCommands(fs: JshDiscoveryFS): Promise<Map<string, string>> {
  const commands = new Map<string, string>();

  // Scan priority roots first
  for (const root of PRIORITY_ROOTS) {
    if (await fs.exists(root)) {
      await scanDir(fs, root, commands);
    }
  }

  // Scan everything from root, skipping already-found basenames
  await scanDir(fs, '/', commands);

  return commands;
}

/** Walk a directory and collect .jsh files into the map (first wins). */
async function scanDir(
  fs: JshDiscoveryFS,
  root: string,
  commands: Map<string, string>
): Promise<void> {
  for await (const filePath of fs.walk(root)) {
    if (!filePath.endsWith('.jsh')) continue;
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
