/**
 * Install-time dependency-tree resolution for ipk (Ice Pack).
 *
 * Pure, dependency-light, individually unit-testable. Given a set of root
 * dependencies (name -> range) and a packument supplier, walk the transitive
 * graph and produce an `InstallPlan` describing the npm-style node_modules
 * layout: compatible duplicates are hoisted to the top, conflicting versions
 * are nested under the dependent's `node_modules/<dep>/node_modules/...`.
 *
 * Placement follows npm/Arborist nearest-scope, satisfies-based dedup:
 *   1. For each edge (name, range) under parent P, walk P's node_modules
 *      ancestor chain NEAREST-FIRST and then the top level to find the
 *      nearest already-placed node for `name`.
 *   2. If the nearest placed `name`'s resolved version satisfies `range`,
 *      REUSE it (no re-resolution, no nested copy).
 *   3. Otherwise resolve `range` to a concrete version and either NEST a
 *      fresh node under P (incompatible) or HOIST one to the top level
 *      (no `name` reachable in any scope).
 *
 * Cycle termination is robust for ALL cycles, including conflicting-version
 * cycles whose concrete versions drift around the loop: when resolving the
 * incoming range yields a name@version that already appears in-progress on
 * the current ancestor path, we place a FRESH terminal node (with empty
 * dependencies) under the requester rather than recursing again or linking
 * back to the in-progress ancestor. The fresh terminal node keeps require()
 * reachability correct while keeping the InstallPlan a finite tree with no
 * object-graph cycles (so it stays serializable and safe to walk).
 *
 * This is architecture 4.1 resolution responsibility #1. #2, require/ipx-time
 * Node module resolution, lives in `resolver.ts`. The two are kept apart
 * because `resolver.ts` is on the kernel worker's eager boot graph (every
 * `require()` goes through it) while this module is only reached from the
 * lazily loaded installer.
 */

import { createLimiter, DEFAULT_FETCH_CONCURRENCY } from './concurrency.js';
import type { Packument, PackumentVersion } from './registry.js';
import { resolveVersion } from './registry.js';
import { satisfies } from './semver.js';

export interface InstallNode {
  name: string;
  version: string;
  resolved: string;
  integrity?: string;
  /** Legacy hex SHA-1 from `dist.shasum`; the integrity check's fallback. */
  shasum?: string;
  /** From the packument version; used to predict PATH bins before materialization. */
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
  /** Packument fetches in flight at once (default {@link DEFAULT_FETCH_CONCURRENCY}). */
  concurrency?: number;
}

/**
 * Resolve the full transitive install plan for `rootDependencies`.
 *
 * The plan is shaped like an npm-style `node_modules` tree:
 *   - the nearest reachable already-placed version that SATISFIES the
 *     incoming range is reused (no re-resolution, no nested copy);
 *   - if the nearest reachable version does not satisfy, a fresh node is
 *     nested under the dependent's `node_modules`;
 *   - if no copy is reachable, a fresh node is hoisted to the top level.
 *
 * Packuments are fetched via the supplied `fetchPackument` and memoized so
 * each name is queried at most once. Placement walks the graph depth-first
 * and in order, so the plan is the same whatever order fetches finish in;
 * to overlap round trips, every edge also PREFETCHES ahead of the walk: once
 * a packument arrives, the version its range would pick has its dependency
 * packuments requested too, at most `concurrency` at a time. A prefetch is
 * only a cache warm-up: a failed or unneeded one is ignored, and a needed
 * one's error surfaces when placement awaits it.
 */
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
      cached = limit(async () => options.fetchPackument(name));
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
        // Shadowed cycle: the in-progress satisfying version is not the nearest
        // reachable copy from the requester's scope, so place a fresh terminal
        // node under the requester to keep require() reachability correct
        // without introducing an object-graph cycle into the InstallPlan.
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
    // Stop speculating; fetches already in flight just land in a dead cache.
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
