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
 * the current ancestor path, we link to that ancestor instead of recursing
 * again.
 *
 * This module owns architecture 4.1 responsibility #1 only (install-time
 * resolution). Module resolution at require/ipx time (responsibility #2) is
 * a separate concern handled by the M4 module loader.
 */

import type { Packument, PackumentVersion } from './registry.js';
import { resolveVersion } from './registry.js';
import { satisfies } from './semver.js';

export interface InstallNode {
  name: string;
  version: string;
  resolved: string;
  integrity?: string;
  dependencies: Record<string, InstallNode>;
}

export interface InstallPlan {
  root: Record<string, InstallNode>;
}

export type PackumentSupplier = (name: string) => Promise<Packument> | Packument;

export interface ResolveDependencyTreeOptions {
  rootDependencies: Record<string, string>;
  fetchPackument: PackumentSupplier;
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
 * Packuments are fetched on demand via the supplied `fetchPackument` and
 * memoized so each name is queried at most once.
 */
export async function resolveDependencyTree(
  options: ResolveDependencyTreeOptions
): Promise<InstallPlan> {
  const top: Record<string, InstallNode> = {};
  const packumentCache = new Map<string, Packument>();

  async function getPackument(name: string): Promise<Packument> {
    let cached = packumentCache.get(name);
    if (cached) return cached;
    cached = await options.fetchPackument(name);
    packumentCache.set(name, cached);
    return cached;
  }

  async function place(name: string, range: string, ancestors: InstallNode[]): Promise<void> {
    const nearest = findNearest(name, ancestors, top);
    if (nearest && satisfies(nearest.version, range)) {
      return;
    }

    const resolved = await resolveEdge(name, range, getPackument);
    if (isInProgress(name, resolved.version, ancestors)) {
      return;
    }

    const node = buildNode(name, resolved.version, resolved.entry);
    attachNode(top, node, nearest, ancestors);

    const childAncestors: InstallNode[] = [node, ...ancestors];
    const deps = resolved.entry.dependencies ?? {};
    for (const [depName, depRange] of Object.entries(deps)) {
      await place(depName, depRange, childAncestors);
    }
  }

  for (const [name, range] of Object.entries(options.rootDependencies)) {
    await place(name, range, []);
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
