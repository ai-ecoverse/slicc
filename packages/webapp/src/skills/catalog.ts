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
const PRUNED_COMPATIBILITY_DIRECTORY_NAMES = new Set(['.git', '.slicc']);
const COMPATIBILITY_CACHE_INVALIDATION_METHODS = [
  'mkdir',
  'mount',
  'rename',
  'rm',
  'unmount',
  'writeFile',
] as const;

const compatibilityCandidatesCache = new WeakMap<object, DiscoveredSkillCandidate[]>();
const compatibilityCacheHooksInstalled = new WeakSet<object>();

export async function discoverSkillCandidates(
  fs: VirtualFS,
  nativeSkillsDir: string = WORKSPACE_SKILLS_PATH
): Promise<DiscoveredSkillCandidate[]> {
  const nativeCandidates = await discoverNativeSkillCandidates(fs, nativeSkillsDir);
  const compatibilityCandidates = await getCompatibilitySkillCandidates(fs);

  return [
    ...DISCOVERY_ORDER.flatMap((source) => {
      const candidates =
        source === 'native'
          ? nativeCandidates
          : compatibilityCandidates.filter((candidate) => candidate.source === source);
      return candidates.sort((a, b) => a.path.localeCompare(b.path));
    }),
  ];
}

async function getCompatibilitySkillCandidates(fs: VirtualFS): Promise<DiscoveredSkillCandidate[]> {
  installCompatibilityCacheInvalidationHooks(fs);

  const cacheKey = fs as object;
  const cached = compatibilityCandidatesCache.get(cacheKey);
  if (cached) {
    return cached.map((candidate) => ({ ...candidate }));
  }

  const discovered = await discoverCompatibilitySkillCandidates(fs);
  compatibilityCandidatesCache.set(cacheKey, discovered);
  return discovered.map((candidate) => ({ ...candidate }));
}

export function resolveSkillNameCollisions<T>(
  entries: readonly T[],
  getName: (entry: T) => string
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
  nativeSkillsDir: string
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

async function discoverCompatibilitySkillCandidates(
  fs: VirtualFS
): Promise<DiscoveredSkillCandidate[]> {
  const discovered: DiscoveredSkillCandidate[] = [];
  const seenPaths = new Set<string>();
  const queue = ['/'];

  for (let index = 0; index < queue.length; index += 1) {
    const currentPath = queue[index];

    const entries = await readSortedDir(fs, currentPath);
    for (const entry of entries) {
      if (entry.type !== 'directory') continue;

      const childPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;

      const source = COMPATIBILITY_DIRECTORY_SOURCES.get(entry.name);
      if (source) {
        const skillRoot = `${childPath}/skills`;
        const skillEntries = await readSortedDir(fs, skillRoot);

        for (const skillEntry of skillEntries) {
          if (skillEntry.type !== 'directory') continue;

          const skillPath = `${skillRoot}/${skillEntry.name}`;
          const skillFilePath = `${skillPath}/${SKILL_FILE}`;
          if (!(await pathExists(fs, skillFilePath)) || seenPaths.has(skillPath)) continue;

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

      if (PRUNED_COMPATIBILITY_DIRECTORY_NAMES.has(entry.name)) continue;

      queue.push(childPath);
    }
  }

  return discovered;
}

function installCompatibilityCacheInvalidationHooks(fs: VirtualFS): void {
  const cacheKey = fs as object;
  if (compatibilityCacheHooksInstalled.has(cacheKey)) return;
  compatibilityCacheHooksInstalled.add(cacheKey);

  const mutableFs = fs as unknown as Record<string, unknown>;
  for (const methodName of COMPATIBILITY_CACHE_INVALIDATION_METHODS) {
    const candidate = mutableFs[methodName];
    if (typeof candidate !== 'function') continue;

    const original = candidate as (...args: unknown[]) => unknown;

    try {
      mutableFs[methodName] = async (...args: unknown[]) => {
        const result = await original.apply(fs, args);
        compatibilityCandidatesCache.delete(cacheKey);
        return result;
      };
    } catch {
      // Some FS wrappers may not allow method reassignment. In that case we
      // keep discovery correct but skip automatic invalidation for this cache.
    }
  }
}

async function pathExists(fs: VirtualFS, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readSortedDir(
  fs: VirtualFS,
  path: string
): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
  try {
    const entries = await fs.readDir(path);
    return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
