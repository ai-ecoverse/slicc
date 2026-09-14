import type { FileContent, ReadFileOptions } from '../fs/types.js';

export interface JshDiscoveryFS {
  exists(path: string): Promise<boolean>;
  walk(path: string): AsyncGenerator<string>;
  readFile(path: string, options?: ReadFileOptions): Promise<FileContent>;
}

export const DEFAULT_JSH_SEARCH_ROOTS = [
  '/workspace/skills',
  '/workspace/.mcp/aliases',
  '/workspace/bin',
  '/shared/bin',
];

export const DEFAULT_SHELL_PATH = `/usr/bin:${DEFAULT_JSH_SEARCH_ROOTS.join(':')}`;

const PRUNED_SEGMENT = /\/(node_modules|\.[^/]+)\//;

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

function commandName(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.endsWith('.jsh') ? base.slice(0, -4) : base;
}
