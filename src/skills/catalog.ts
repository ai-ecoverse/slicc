import type { VirtualFS } from '../fs/index.js';
import { MANIFEST_FILE, SKILL_FILE, WORKSPACE_SKILLS_PATH } from './constants.js';

export type SkillDiscoverySource = 'native' | 'agents' | 'claude';

export interface DiscoveredSkillCandidate {
  /** Discovery source bucket used for precedence. */
  source: SkillDiscoverySource;
  /** Root directory that contained the skill candidate. */
  sourceRoot: string;
  /** Path to the skill directory. */
  path: string;
  /** Path to SKILL.md when present. */
  skillFilePath?: string;
  /** Whether the directory also contains manifest.yaml. */
  hasManifest: boolean;
}

export interface SkillNameCollision<T> {
  name: string;
  winner: T;
  shadowed: T[];
}

const DISCOVERY_ORDER: SkillDiscoverySource[] = ['native', 'agents', 'claude'];
const COMPATIBILITY_DIRECTORY_SOURCES = new Map<string, Exclude<SkillDiscoverySource, 'native'>>([
  ['.agents', 'agents'],
  ['.claude', 'claude'],
]);

export async function discoverSkillCandidates(
  fs: VirtualFS,
  nativeSkillsDir: string = WORKSPACE_SKILLS_PATH,
): Promise<DiscoveredSkillCandidate[]> {
  const nativeCandidates = await discoverNativeSkillCandidates(fs, nativeSkillsDir);
  const compatibilityCandidates = await discoverCompatibilitySkillCandidates(fs);

  return [...DISCOVERY_ORDER.flatMap((source) => {
    const candidates = source === 'native'
      ? nativeCandidates
      : compatibilityCandidates.filter((candidate) => candidate.source === source);
    return candidates.sort((a, b) => a.path.localeCompare(b.path));
  })];
}

export function resolveSkillNameCollisions<T>(
  entries: readonly T[],
  getName: (entry: T) => string,
): { winners: T[]; collisions: SkillNameCollision<T>[] } {
  const winners = new Map<string, T>();
  const collisions = new Map<string, SkillNameCollision<T>>();

  for (const entry of entries) {
    const name = getName(entry);
    if (!winners.has(name)) {
      winners.set(name, entry);
      continue;
    }

    const collision = collisions.get(name) ?? {
      name,
      winner: winners.get(name)!,
      shadowed: [],
    };
    collision.shadowed.push(entry);
    collisions.set(name, collision);
  }

  return {
    winners: Array.from(winners.values()),
    collisions: Array.from(collisions.values()),
  };
}

async function discoverNativeSkillCandidates(
  fs: VirtualFS,
  nativeSkillsDir: string,
): Promise<DiscoveredSkillCandidate[]> {
  const entries = await readSortedDir(fs, nativeSkillsDir);
  const discovered: DiscoveredSkillCandidate[] = [];

  for (const entry of entries) {
    if (entry.type !== 'directory') continue;

    const skillPath = `${nativeSkillsDir}/${entry.name}`;
    const manifestPath = `${skillPath}/${MANIFEST_FILE}`;
    const skillFilePath = `${skillPath}/${SKILL_FILE}`;
    const hasManifest = await pathExists(fs, manifestPath);
    const hasSkillFile = await pathExists(fs, skillFilePath);

    if (!hasManifest && !hasSkillFile) continue;

    discovered.push({
      source: 'native',
      sourceRoot: nativeSkillsDir,
      path: skillPath,
      skillFilePath: hasSkillFile ? skillFilePath : undefined,
      hasManifest,
    });
  }

  return discovered;
}

async function discoverCompatibilitySkillCandidates(fs: VirtualFS): Promise<DiscoveredSkillCandidate[]> {
  const discovered: DiscoveredSkillCandidate[] = [];
  const seenPaths = new Set<string>();
  const queue = ['/'];

  while (queue.length > 0) {
    const currentPath = queue.shift()!;

    const entries = await readSortedDir(fs, currentPath);
    for (const entry of entries) {
      if (entry.type !== 'directory') continue;

      const childPath = currentPath === '/'
        ? `/${entry.name}`
        : `${currentPath}/${entry.name}`;

      const source = COMPATIBILITY_DIRECTORY_SOURCES.get(entry.name);
      if (source) {
        const skillRoot = `${childPath}/skills`;
        const skillEntries = await readSortedDir(fs, skillRoot);

        for (const skillEntry of skillEntries) {
          if (skillEntry.type !== 'directory') continue;

          const skillPath = `${skillRoot}/${skillEntry.name}`;
          const skillFilePath = `${skillPath}/${SKILL_FILE}`;
          if (!await pathExists(fs, skillFilePath) || seenPaths.has(skillPath)) continue;

          seenPaths.add(skillPath);
          discovered.push({
            source,
            sourceRoot: skillRoot,
            path: skillPath,
            skillFilePath,
            hasManifest: false,
          });
        }
      }

      queue.push(childPath);
    }
  }

  return discovered;
}

async function pathExists(fs: VirtualFS, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readSortedDir(fs: VirtualFS, path: string): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
  try {
    const entries = await fs.readDir(path);
    return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}