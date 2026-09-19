/**
 * JSH Discovery — scan an ordered list of search roots for `.jsh` shell
 * script files and build a map of command names (basename without
 * extension) to VFS paths.
 *
 * The roots come from the shell's `$PATH` (#2085): command lookup is
 * "read these directories", not "walk the entire VFS". Earlier roots win
 * a basename conflict across PATH entries. Within one root, two skills
 * that ship the same command are ranked: a `.upskill` provenance record
 * beats a bundled copy, a newer `installed` timestamp beats an older one,
 * and a remaining tie keeps the first scan hit. Collisions are never
 * silent — they travel with the index so `skill list`, `which`, and load
 * can report the loser. Each root is scanned recursively — a skill's
 * commands live wherever the skill keeps them
 * (`/workspace/skills/<skill>/scripts/…`) — but vendored `node_modules`
 * and dot-directories never register commands.
 */

import type { FileContent, ReadFileOptions } from '../fs/types.js';

/** Minimal filesystem interface needed for JSH discovery and script reading. */
export interface JshDiscoveryFS {
  exists(path: string): Promise<boolean>;
  walk(path: string): AsyncGenerator<string>;
  readFile(path: string, options?: ReadFileOptions): Promise<FileContent>;
}

/** Why this path won a same-root `.jsh` basename collision. */
export type JshCollisionReason = 'upskill-provenance' | 'newer-upskill' | 'first-scan';

/** One command name claimed by more than one `.jsh` under the same PATH root. */
export interface JshCommandCollision {
  name: string;
  winnerPath: string;
  shadowedPaths: string[];
  reason: JshCollisionReason;
}

/** Discovery result: the live command map plus every same-root collision. */
export interface JshCommandIndex {
  commands: Map<string, string>;
  collisions: JshCommandCollision[];
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
 * Discover `.jsh` files under the given search roots and return the live
 * command map plus same-root basename collisions.
 *
 * Earlier PATH roots still win outright. Within one root, see
 * {@link JshCollisionReason}. Defaults to {@link DEFAULT_JSH_SEARCH_ROOTS}.
 */
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

/**
 * Discover `.jsh` files under the given search roots and return a map of
 * command name → VFS path. Earlier roots win a basename conflict. Same-root
 * collisions prefer `.upskill` provenance (see {@link discoverJshCommandIndex}).
 *
 * Defaults to {@link DEFAULT_JSH_SEARCH_ROOTS}; callers with a live shell
 * env derive the list via {@link pathToScanRoots} so `export PATH=…`
 * (interactive or from `~/.profile`) extends command lookup.
 */
export async function discoverJshCommands(
  fs: JshDiscoveryFS,
  roots: readonly string[] = DEFAULT_JSH_SEARCH_ROOTS
): Promise<Map<string, string>> {
  return (await discoverJshCommandIndex(fs, roots)).commands;
}

/** Human listing of same-root `.jsh` collisions for `skill list` / `upskill list`. */
export function formatJshCommandCollisions(collisions: readonly JshCommandCollision[]): string {
  if (collisions.length === 0) return '';
  const lines = ['Command collisions:'];
  for (const collision of collisions) {
    lines.push(`  ${collision.name}  live     ${collision.winnerPath}  (${collision.reason})`);
    for (const shadowed of collision.shadowedPaths) {
      lines.push(`          shadowed ${shadowed}`);
    }
  }
  lines.push(
    'Resolution: a skill with .upskill provenance wins over a bundled copy; newer .upskill installed timestamp wins among provenanced skills; otherwise the first scan hit wins.'
  );
  return `${lines.join('\n')}\n`;
}

/** Append collision listing to stdout and a one-line warning on stderr. */
export function withJshCommandCollisions(
  commandName: string,
  stdout: string,
  collisions: readonly JshCommandCollision[]
): { stdout: string; stderr: string } {
  if (collisions.length === 0) return { stdout, stderr: '' };
  const noun = collisions.length === 1 ? 'command name collision' : 'command name collisions';
  return {
    stdout: `${stdout}\n${formatJshCommandCollisions(collisions)}`,
    stderr: `${commandName}: ${collisions.length} ${noun} — see listing\n`,
  };
}

const UPSKILL_FILE = '.upskill';

interface RankedJshCandidate {
  path: string;
  provenanced: boolean;
  installedMs: number;
}

/** Walk a directory, collect .jsh files, and resolve same-root basename collisions. */
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

/** Positive when `a` should replace `b`. Equal ranks keep the earlier scan hit. */
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

/**
 * Skill directory for a `.jsh` under a `…/skills` scan root. Direct files in
 * the skills root (not inside a skill folder) have no provenance.
 */
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

/** Extract command name from a .jsh file path (basename minus extension). */
function commandName(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.endsWith('.jsh') ? base.slice(0, -4) : base;
}
