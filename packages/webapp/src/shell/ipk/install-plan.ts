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
 * Required `peerDependencies` are installed too (npm 7+ semantics), in a
 * second phase once every root and regular dependency has been placed, so a
 * version the user asked for directly is what a peer range gets checked
 * against. A peer resolves against the dependent's parent scope (what
 * require() reaches from its siblings up to the top level, then what is
 * already installed at the top of `node_modules`): a satisfying copy there is
 * reused, a conflicting one is kept and reported as a warning, and a missing
 * peer is hoisted to the top level. Peers marked optional in
 * `peerDependenciesMeta` are never installed.
 *
 * This is architecture 4.1 resolution responsibility #1. #2, require/ipx-time
 * Node module resolution, lives in `resolver.ts`. The two are kept apart
 * because `resolver.ts` is on the kernel worker's eager boot graph (every
 * `require()` goes through it) while this module is only reached from the
 * lazily loaded installer.
 */

import { createLimiter, DEFAULT_FETCH_CONCURRENCY } from './concurrency.js';
import { describeUnsupportedPlatform, isPlatformSupported } from './platform.js';
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
  /** Optional dependencies left out, each with an npm-style note. */
  skippedOptional: SkippedOptional[];
  /** Non-fatal npm-style warnings, e.g. an ERESOLVE peer dependency conflict. */
  warnings: string[];
}

export interface SkippedOptional {
  name: string;
  range: string;
  /** The version that was picked, when resolution got that far. */
  version?: string;
  /** e.g. `skipping optional dependency fsevents@2.3.3 (unsupported platform: …)`. */
  note: string;
}

export type PackumentSupplier = (name: string) => Promise<Packument> | Packument;

export interface ResolveDependencyTreeOptions {
  rootDependencies: Record<string, string>;
  fetchPackument: PackumentSupplier;
  /** Packument fetches in flight at once (default {@link DEFAULT_FETCH_CONCURRENCY}). */
  concurrency?: number;
  /** Root names declared under `optionalDependencies`: skipped, not fatal, when unusable. */
  optionalRoots?: ReadonlySet<string>;
  /**
   * Version of `name` already installed at the top of the target
   * `node_modules`, if any. A peer range that this version satisfies reuses
   * it instead of resolving the newest match.
   */
  installedVersion?: (name: string) => Promise<string | undefined> | string | undefined;
  /**
   * True when a top-level package the plan does not place stays on disk
   * (a named project install). Then a conflicting installed peer is kept and
   * warned about; otherwise it is about to be pruned, so the peer is
   * resolved as if missing.
   */
  installedStays?: boolean;
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
 * `optionalDependencies` are followed like `dependencies`, except that an
 * optional edge that cannot be resolved, or whose picked version's `os`/`cpu`
 * exclude the wasm install host (`platform.ts`), is left out and reported in
 * `skippedOptional` instead of failing the install. A non-optional
 * dependency is installed whatever its `os`/`cpu` say, as before.
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
  const skipped = new Map<string, SkippedOptional>();
  const warnings: string[] = [];
  /** Where each placed node's parent scope starts: `[]` at the top level. */
  const scopeOf = new WeakMap<InstallNode, InstallNode[]>();
  const pendingPeers: PendingPeer[] = [];
  let settled = false;

  function skip(entry: SkippedOptional): void {
    const key = `${entry.name}@${entry.version ?? entry.range}`;
    if (!skipped.has(key)) skipped.set(key, entry);
  }

  function getPackument(name: string): Promise<Packument> {
    let cached = packumentCache.get(name);
    if (!cached) {
      cached = limit(async () => {
        // Placement awaits every packument it needs before the walk ends, so
        // a fetch still queued once it has ended is speculative: drop it.
        if (settled) throw new Error(`fetchPackument(${name}): resolution already finished`);
        return options.fetchPackument(name);
      });
      packumentCache.set(name, cached);
    }
    return cached;
  }

  function prefetch(edge: Edge): void {
    const key = `${edge.name}@${edge.range}`;
    if (settled || prefetched.has(key)) return;
    prefetched.add(key);
    getPackument(edge.name).then(
      (packument) => {
        let entry: PackumentVersion | undefined;
        try {
          entry = packument.versions[resolveVersion(packument, edge.range)];
        } catch {
          return;
        }
        if (!entry || (edge.optional && !isPlatformSupported(entry))) return;
        for (const child of edgesOf(entry)) prefetch(child);
        for (const peer of peerEdgesOf(entry)) prefetch(peer);
      },
      () => undefined
    );
  }

  /**
   * Resolve an optional edge, or record why it is skipped and return null:
   * it cannot be resolved, or its `os`/`cpu` exclude the install host.
   */
  async function resolveOptional(edge: Edge): Promise<ResolvedEdge | null> {
    let resolved: ResolvedEdge;
    try {
      resolved = await resolveEdge(edge.name, edge.range, getPackument);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skip({
        name: edge.name,
        range: edge.range,
        note: `skipping optional dependency ${edge.name}@${edge.range} (${reason})`,
      });
      return null;
    }
    if (isPlatformSupported(resolved.entry)) return resolved;
    const id = `${edge.name}@${resolved.version}`;
    skip({
      name: edge.name,
      range: edge.range,
      version: resolved.version,
      note: `skipping optional dependency ${id} (unsupported platform): ${describeUnsupportedPlatform(id, resolved.entry)}`,
    });
    return null;
  }

  async function place(edge: Edge, ancestors: InstallNode[]): Promise<void> {
    const { name, range } = edge;
    const nearest = findNearest(name, ancestors, top);
    if (nearest && satisfies(nearest.version, range)) {
      return;
    }

    const resolved = edge.optional
      ? await resolveOptional(edge)
      : await resolveEdge(name, range, getPackument);
    if (!resolved) return;
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
    const nested = attachNode(top, node, nearest, ancestors);
    await placeChildren(node, resolved.entry, ancestors, nested ? ancestors : []);
  }

  /**
   * Place `node`'s dependencies below `ancestors` and queue its required
   * peers, which resolve from `scope`: the ancestors whose `node_modules`
   * hold `node` (`[]` when it sits at the top level).
   */
  async function placeChildren(
    node: InstallNode,
    entry: PackumentVersion,
    ancestors: InstallNode[],
    scope: InstallNode[]
  ): Promise<void> {
    scopeOf.set(node, scope);
    const children = edgesOf(entry);
    const peers = peerEdgesOf(entry);
    for (const child of children) prefetch(child);
    for (const peer of peers) prefetch(peer);
    for (const peer of peers) pendingPeers.push({ dependent: node, edge: peer });
    const childAncestors: InstallNode[] = [node, ...ancestors];
    for (const child of children) {
      await place(child, childAncestors);
    }
  }

  async function placePeer({ dependent, edge }: PendingPeer): Promise<void> {
    const { name, range } = edge;
    const scope = scopeOf.get(dependent) ?? [];
    const from = `${dependent.name}@${dependent.version}`;
    const nearest = findNearest(name, scope, top);
    if (nearest) {
      if (!satisfies(nearest.version, range)) {
        warnings.push(await peerConflict(getPackument, name, range, from, nearest.version));
      }
      return;
    }

    const installed = await options.installedVersion?.(name);
    let resolved: ResolvedEdge | null = null;
    if (installed !== undefined) {
      if (satisfies(installed, range)) {
        resolved = await installedEdge(name, installed, getPackument);
        // Kept on disk but unknown to the registry: leave it be.
        if (!resolved && options.installedStays) return;
      } else if (options.installedStays) {
        warnings.push(await peerConflict(getPackument, name, range, from, installed));
        return;
      }
    }
    resolved ??= await resolveEdge(name, range, getPackument);

    const node = buildNode(name, resolved.version, resolved.entry);
    top[name] = node;
    await placeChildren(node, resolved.entry, [], []);
  }

  const roots: Edge[] = Object.entries(options.rootDependencies).map(([name, range]) => ({
    name,
    range,
    optional: options.optionalRoots?.has(name) ?? false,
  }));
  for (const root of roots) prefetch(root);
  try {
    for (const root of roots) {
      await place(root, []);
    }
    // Peers after every root and regular dependency, so they check against
    // what was asked for; a placed peer can queue peers of its own.
    for (let i = 0; i < pendingPeers.length; i++) {
      await placePeer(pendingPeers[i]);
    }
  } finally {
    // Stop speculating: queued fetches are dropped when their turn comes, and
    // ones already in flight just land in a dead cache.
    settled = true;
  }

  return { root: top, skippedOptional: [...skipped.values()], warnings };
}

interface Edge {
  name: string;
  range: string;
  /** From `optionalDependencies`: skipped, never fatal, when it cannot be used. */
  optional: boolean;
}

/**
 * A version's outgoing edges: `dependencies` plus `optionalDependencies`.
 * A name in both is optional, as npm treats it (the optional range wins).
 */
function edgesOf(entry: PackumentVersion): Edge[] {
  const edges = new Map<string, Edge>();
  for (const [name, range] of Object.entries(entry.dependencies ?? {})) {
    edges.set(name, { name, range, optional: false });
  }
  for (const [name, range] of Object.entries(entry.optionalDependencies ?? {})) {
    edges.set(name, { name, range, optional: true });
  }
  return [...edges.values()];
}

interface PendingPeer {
  dependent: InstallNode;
  edge: Edge;
}

/**
 * A version's required peers: `peerDependencies` minus names marked
 * `peerDependenciesMeta.<name>.optional`, and minus names it also lists as a
 * (regular or optional) dependency, which `edgesOf` already follows.
 */
function peerEdgesOf(entry: PackumentVersion): Edge[] {
  const peers = entry.peerDependencies;
  if (!peers || typeof peers !== 'object') return [];
  const meta = entry.peerDependenciesMeta;
  const edges: Edge[] = [];
  for (const [name, range] of Object.entries(peers)) {
    if (typeof range !== 'string') continue;
    if (meta?.[name]?.optional === true) continue;
    if (entry.dependencies?.[name] !== undefined) continue;
    if (entry.optionalDependencies?.[name] !== undefined) continue;
    edges.push({ name, range, optional: false });
  }
  return edges;
}

/** The packument entry for an installed version, or null when it is gone. */
async function installedEdge(
  name: string,
  version: string,
  getPackument: (name: string) => Promise<Packument>
): Promise<ResolvedEdge | null> {
  try {
    const entry = (await getPackument(name)).versions[version];
    return entry?.dist?.tarball ? { version, entry } : null;
  } catch {
    return null;
  }
}

/** npm's ERESOLVE "overriding peer dependency" warning, on one line. */
async function peerConflict(
  getPackument: (name: string) => Promise<Packument>,
  name: string,
  range: string,
  from: string,
  found: string
): Promise<string> {
  let wanted = '';
  try {
    wanted = `; Conflicting peer dependency: ${name}@${resolveVersion(await getPackument(name), range)}`;
  } catch {
    // The warning still names the range; the best match is a courtesy.
  }
  return `warn ERESOLVE overriding peer dependency: While resolving: ${from}; Found: ${name}@${found}; Could not resolve dependency: peer ${name}@"${range}" from ${from}${wanted}; keeping ${name}@${found}`;
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
): boolean {
  const parent = nearest ? ancestors[0] : null;
  if (parent) {
    parent.dependencies[node.name] = node;
    return true;
  }
  top[node.name] = node;
  return false;
}
