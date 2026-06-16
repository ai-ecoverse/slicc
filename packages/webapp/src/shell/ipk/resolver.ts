/**
 * Install-time dependency-tree resolution for ipk (Ice Pack).
 *
 * Pure, dependency-light, individually unit-testable. Given a set of root
 * dependencies (name -> range) and a packument supplier, walk the transitive
 * graph and produce an `InstallPlan` describing the npm-style node_modules
 * layout: compatible duplicates are hoisted to the top, conflicting versions
 * are nested under the dependent's `node_modules/<dep>/node_modules/...`.
 *
 * Cycles in the dependency graph terminate (the walk reuses an existing entry
 * for the same name + concrete version instead of re-enqueuing its deps).
 *
 * This module owns architecture 4.1 responsibility #1 only (install-time
 * resolution). Module resolution at require/ipx time (responsibility #2) is
 * a separate concern handled by the M4 module loader.
 */

import type { Packument, PackumentVersion } from './registry.js';
import { resolveVersion } from './registry.js';

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

interface WorkItem {
  name: string;
  range: string;
  ancestors: InstallNode[];
}

/**
 * Resolve the full transitive install plan for `rootDependencies`.
 *
 * The plan is shaped like an npm-style `node_modules` tree:
 *   - the first concrete version chosen for a given name is hoisted to the top;
 *   - any later request that resolves to a different concrete version is nested
 *     under the immediate requester's `dependencies`;
 *   - any later request that resolves to the same already-placed version is
 *     skipped (it would refer to the existing entry on disk).
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

  const queue: WorkItem[] = [];
  for (const [name, range] of Object.entries(options.rootDependencies)) {
    queue.push({ name, range, ancestors: [] });
  }

  while (queue.length > 0) {
    const item = queue.shift() as WorkItem;

    let packument: Packument;
    let version: string;
    try {
      packument = await getPackument(item.name);
      version = resolveVersion(packument, item.range);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `resolveDependencyTree: failed to resolve ${item.name}@${item.range}: ${reason}`
      );
    }

    const existing = findNearest(item.name, item.ancestors, top);
    if (existing && existing.version === version) {
      continue;
    }

    const versionEntry = packument.versions[version] as PackumentVersion | undefined;
    if (!versionEntry?.dist?.tarball) {
      throw new Error(
        `resolveDependencyTree: ${item.name}@${version} has no dist.tarball in the packument`
      );
    }

    const node: InstallNode = {
      name: item.name,
      version,
      resolved: versionEntry.dist.tarball,
      dependencies: {},
    };
    if (typeof versionEntry.dist.integrity === 'string') {
      node.integrity = versionEntry.dist.integrity;
    }

    if (existing) {
      const parent = item.ancestors[0];
      if (!parent) continue;
      parent.dependencies[item.name] = node;
    } else {
      top[item.name] = node;
    }

    const childAncestors: InstallNode[] = [node, ...item.ancestors];
    const deps = versionEntry.dependencies ?? {};
    for (const [depName, depRange] of Object.entries(deps)) {
      queue.push({ name: depName, range: depRange, ancestors: childAncestors });
    }
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
