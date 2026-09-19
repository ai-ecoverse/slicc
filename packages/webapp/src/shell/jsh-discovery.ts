import type { FileContent, ReadFileOptions } from '../fs/types.js';

export interface JshDiscoveryFS {
  exists(path: string): Promise<boolean>;
  walk(path: string): AsyncGenerator<string>;
  readFile(path: string, options?: ReadFileOptions): Promise<FileContent>;
}

export type JshCollisionReason = 'upskill-provenance' | 'newer-upskill' | 'first-scan';

export interface JshCommandCollision {
  name: string;
  winnerPath: string;
  shadowedPaths: string[];
  reason: JshCollisionReason;
}

export interface JshCommandIndex {
  commands: Map<string, string>;
  collisions: JshCommandCollision[];
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

export function jshScanRootsFromPath(pathValue: string | undefined): readonly string[] | undefined {
  return pathValue === undefined ? undefined : pathToScanRoots(pathValue);
}

export async function discoverJshCommandIndex(
  fs: JshDiscoveryFS,
  roots: readonly string[] = DEFAULT_JSH_SEARCH_ROOTS
): Promise<JshCommandIndex> {
  const commands = new Map<string, string>();
  const collisions: JshCommandCollision[] = [];
  for (const root of roots) {
    if (await fs.exists(root).catch(() => false)) {
      collisions.push(...(await scanDir(fs, root, commands)));
    }
  }
  return { commands, collisions };
}

export async function discoverJshCommands(
  fs: JshDiscoveryFS,
  roots: readonly string[] = DEFAULT_JSH_SEARCH_ROOTS
): Promise<Map<string, string>> {
  return (await discoverJshCommandIndex(fs, roots)).commands;
}

export interface FormatJshCollisionsOptions {
  builtinNames?: ReadonlySet<string>;
}

export function formatJshCommandCollisions(
  collisions: readonly JshCommandCollision[],
  options: FormatJshCollisionsOptions = {}
): string {
  if (collisions.length === 0) return '';
  const lines = ['Command collisions:'];
  for (const collision of collisions) {
    if (options.builtinNames?.has(collision.name)) {
      lines.push(`  ${collision.name}  shadowed by built-in ${collision.name}`);
      lines.push(`          ${collision.winnerPath}`);
      for (const shadowed of collision.shadowedPaths) {
        lines.push(`          ${shadowed}`);
      }
      continue;
    }
    lines.push(`  ${collision.name}  live     ${collision.winnerPath}  (${collision.reason})`);
    for (const shadowed of collision.shadowedPaths) {
      lines.push(`          shadowed ${shadowed}`);
    }
  }
  lines.push(
    'Resolution: a skill with .upskill provenance wins over a bundled copy; newer .upskill installed timestamp wins among provenanced skills; otherwise the first scan hit wins. A built-in of the same name still takes precedence at dispatch.'
  );
  return `${lines.join('\n')}\n`;
}

export function withJshCommandCollisions(
  commandName: string,
  stdout: string,
  collisions: readonly JshCommandCollision[],
  options: FormatJshCollisionsOptions = {}
): { stdout: string; stderr: string } {
  if (collisions.length === 0) return { stdout, stderr: '' };
  const noun = collisions.length === 1 ? 'command name collision' : 'command name collisions';
  return {
    stdout: `${stdout}\n${formatJshCommandCollisions(collisions, options)}`,
    stderr: `${commandName}: ${collisions.length} ${noun} — see listing\n`,
  };
}

const UPSKILL_FILE = '.upskill';

interface RankedJshCandidate {
  path: string;
  provenanced: boolean;
  installedMs: number;
}

async function scanDir(
  fs: JshDiscoveryFS,
  root: string,
  commands: Map<string, string>
): Promise<JshCommandCollision[]> {
  const rootPrefix = root.replace(/\/+$/, '');
  const candidates = new Map<string, string[]>();
  for await (const filePath of fs.walk(root)) {
    if (!filePath.endsWith('.jsh')) continue;
    if (PRUNED_SEGMENT.test(filePath.slice(rootPrefix.length))) continue;
    const name = commandName(filePath);
    const paths = candidates.get(name);
    if (paths) paths.push(filePath);
    else candidates.set(name, [filePath]);
  }

  const collisions: JshCommandCollision[] = [];
  for (const [name, paths] of candidates) {
    if (commands.has(name)) continue;
    if (paths.length === 1) {
      const only = paths[0];
      if (only) commands.set(name, only);
      continue;
    }
    const ranked = await rankCandidates(fs, rootPrefix, paths);
    const winner = pickWinner(ranked);
    commands.set(name, winner.path);
    collisions.push({
      name,
      winnerPath: winner.path,
      shadowedPaths: ranked.filter((c) => c.path !== winner.path).map((c) => c.path),
      reason: collisionReason(winner, ranked),
    });
  }
  return collisions;
}

async function rankCandidates(
  fs: JshDiscoveryFS,
  rootPrefix: string,
  paths: readonly string[]
): Promise<RankedJshCandidate[]> {
  const ranked: RankedJshCandidate[] = [];
  for (const path of paths) {
    ranked.push(await rankCandidate(fs, rootPrefix, path));
  }
  return ranked;
}

async function rankCandidate(
  fs: JshDiscoveryFS,
  rootPrefix: string,
  path: string
): Promise<RankedJshCandidate> {
  const skillDir = skillDirForJsh(path, rootPrefix);
  if (!skillDir) return { path, provenanced: false, installedMs: 0 };
  const installedMs = await readProvenanceInstalledMs(fs, skillDir);
  if (installedMs === null) return { path, provenanced: false, installedMs: 0 };
  return { path, provenanced: true, installedMs };
}

function pickWinner(ranked: readonly RankedJshCandidate[]): RankedJshCandidate {
  const [first, ...rest] = ranked;
  if (!first) {
    throw new Error('jsh collision ranking requires at least one candidate');
  }
  return rest.reduce(
    (best, candidate) => (compareRanks(candidate, best) > 0 ? candidate : best),
    first
  );
}

function compareRanks(a: RankedJshCandidate, b: RankedJshCandidate): number {
  if (a.provenanced !== b.provenanced) return a.provenanced ? 1 : -1;
  return a.installedMs - b.installedMs;
}

function collisionReason(
  winner: RankedJshCandidate,
  all: readonly RankedJshCandidate[]
): JshCollisionReason {
  const others = all.filter((c) => c.path !== winner.path);
  if (winner.provenanced && others.some((o) => !o.provenanced)) return 'upskill-provenance';
  if (
    winner.provenanced &&
    others.some((o) => o.provenanced && o.installedMs < winner.installedMs)
  ) {
    return 'newer-upskill';
  }
  return 'first-scan';
}

function skillDirForJsh(jshPath: string, rootPrefix: string): string | null {
  if (!rootPrefix.endsWith('/skills')) return null;
  const prefix = `${rootPrefix}/`;
  if (!jshPath.startsWith(prefix)) return null;
  const skillName = jshPath.slice(prefix.length).split('/')[0];
  if (!skillName || skillName.endsWith('.jsh')) return null;
  return `${rootPrefix}/${skillName}`;
}

async function readProvenanceInstalledMs(
  fs: JshDiscoveryFS,
  skillDir: string
): Promise<number | null> {
  if (typeof fs.readFile !== 'function') return null;
  try {
    const raw = await fs.readFile(`${skillDir}/${UPSKILL_FILE}`, { encoding: 'utf-8' });
    return parseInstalledMs(asText(raw));
  } catch {
    return null;
  }
}

function asText(content: FileContent): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

function parseInstalledMs(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as { kind?: unknown; source?: unknown; installed?: unknown };
    if (typeof record.kind !== 'string' || typeof record.source !== 'string') return null;
    if (typeof record.installed !== 'string') return 0;
    const ms = Date.parse(record.installed);
    return Number.isFinite(ms) ? ms : 0;
  } catch {
    return null;
  }
}

function commandName(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.endsWith('.jsh') ? base.slice(0, -4) : base;
}
