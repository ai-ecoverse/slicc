import { createLimiter, DEFAULT_FETCH_CONCURRENCY } from './concurrency.js';
import type { Packument, PackumentVersion } from './registry.js';
import { resolveVersion } from './registry.js';
import { satisfies } from './semver.js';

export interface InstallNode {
  name: string;
  version: string;
  resolved: string;
  integrity?: string;

  shasum?: string;

  bin?: string | Record<string, string>;
  dependencies: Record<string, InstallNode>;
}

export interface InstallPlan {
  root: Record<string, InstallNode>;
}

export type PackumentSupplier = (name: string) => Promise<Packument> | Packument;

export interface ResolveDependencyTreeOptions {
  rootDependencies: Record<string, string>;
  fetchPackument: PackumentSupplier;

  concurrency?: number;
}

export async function resolveDependencyTree(
  options: ResolveDependencyTreeOptions
): Promise<InstallPlan> {
  const top: Record<string, InstallNode> = {};
  const packumentCache = new Map<string, Promise<Packument>>();
  const limit = createLimiter(options.concurrency ?? DEFAULT_FETCH_CONCURRENCY);
  const prefetched = new Set<string>();
  let settled = false;

  function getPackument(name: string): Promise<Packument> {
    let cached = packumentCache.get(name);
    if (!cached) {
      cached = limit(async () => {
        if (settled) throw new Error(`fetchPackument(${name}): resolution already finished`);
        return options.fetchPackument(name);
      });
      packumentCache.set(name, cached);
    }
    return cached;
  }

  function prefetch(name: string, range: string): void {
    const key = `${name}@${range}`;
    if (settled || prefetched.has(key)) return;
    prefetched.add(key);
    getPackument(name).then(
      (packument) => {
        let entry: PackumentVersion | undefined;
        try {
          entry = packument.versions[resolveVersion(packument, range)];
        } catch {
          return;
        }
        for (const [depName, depRange] of Object.entries(entry?.dependencies ?? {})) {
          prefetch(depName, depRange);
        }
      },
      () => undefined
    );
  }

  async function place(name: string, range: string, ancestors: InstallNode[]): Promise<void> {
    const nearest = findNearest(name, ancestors, top);
    if (nearest && satisfies(nearest.version, range)) {
      return;
    }

    const resolved = await resolveEdge(name, range, getPackument);
    if (isInProgress(name, resolved.version, ancestors)) {
      const requester = ancestors[0];
      if (requester) {
        requester.dependencies[name] = buildNode(name, resolved.version, resolved.entry);
      }
      return;
    }

    const node = buildNode(name, resolved.version, resolved.entry);
    attachNode(top, node, nearest, ancestors);

    const childAncestors: InstallNode[] = [node, ...ancestors];
    const deps = resolved.entry.dependencies ?? {};
    for (const [depName, depRange] of Object.entries(deps)) prefetch(depName, depRange);
    for (const [depName, depRange] of Object.entries(deps)) {
      await place(depName, depRange, childAncestors);
    }
  }

  const roots = Object.entries(options.rootDependencies);
  for (const [name, range] of roots) prefetch(name, range);
  try {
    for (const [name, range] of roots) {
      await place(name, range, []);
    }
  } finally {
    settled = true;
  }

  return { root: top };
}

function findNearest(
  name: string,
  ancestors: InstallNode[],
  top: Record<string, InstallNode>
): InstallNode | null {
  for (const a of ancestors) {
    const inAncestor = a.dependencies[name];
    if (inAncestor) return inAncestor;
  }
  return top[name] ?? null;
}

interface ResolvedEdge {
  version: string;
  entry: PackumentVersion;
}

async function resolveEdge(
  name: string,
  range: string,
  getPackument: (name: string) => Promise<Packument>
): Promise<ResolvedEdge> {
  let packument: Packument;
  let version: string;
  try {
    packument = await getPackument(name);
    version = resolveVersion(packument, range);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`resolveDependencyTree: failed to resolve ${name}@${range}: ${reason}`);
  }

  const entry = packument.versions[version] as PackumentVersion | undefined;
  if (!entry?.dist?.tarball) {
    throw new Error(
      `resolveDependencyTree: ${name}@${version} has no dist.tarball in the packument`
    );
  }
  return { version, entry };
}

function isInProgress(name: string, version: string, ancestors: InstallNode[]): boolean {
  for (const a of ancestors) {
    if (a.name === name && a.version === version) return true;
  }
  return false;
}

function buildNode(name: string, version: string, entry: PackumentVersion): InstallNode {
  const node: InstallNode = {
    name,
    version,
    resolved: entry.dist.tarball,
    dependencies: {},
  };
  if (typeof entry.dist.integrity === 'string') {
    node.integrity = entry.dist.integrity;
  }
  if (typeof entry.dist.shasum === 'string') {
    node.shasum = entry.dist.shasum;
  }
  if (entry.bin !== undefined && entry.bin !== null) {
    node.bin = entry.bin;
  }
  return node;
}

function attachNode(
  top: Record<string, InstallNode>,
  node: InstallNode,
  nearest: InstallNode | null,
  ancestors: InstallNode[]
): void {
  const parent = nearest ? ancestors[0] : null;
  if (parent) {
    parent.dependencies[node.name] = node;
  } else {
    top[node.name] = node;
  }
}
