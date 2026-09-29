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

  shasum?: string;

  bin?: string | Record<string, string>;
  dependencies: Record<string, InstallNode>;
}

export interface InstallPlan {
  root: Record<string, InstallNode>;

  skippedOptional: SkippedOptional[];
}

export interface SkippedOptional {
  name: string;
  range: string;

  version?: string;

  note: string;
}

export type PackumentSupplier = (name: string) => Promise<Packument> | Packument;

export interface ResolveDependencyTreeOptions {
  rootDependencies: Record<string, string>;
  fetchPackument: PackumentSupplier;

  concurrency?: number;

  optionalRoots?: ReadonlySet<string>;
}

export async function resolveDependencyTree(
  options: ResolveDependencyTreeOptions
): Promise<InstallPlan> {
  const top: Record<string, InstallNode> = {};
  const packumentCache = new Map<string, Promise<Packument>>();
  const limit = createLimiter(options.concurrency ?? DEFAULT_FETCH_CONCURRENCY);
  const prefetched = new Set<string>();
  const skipped = new Map<string, SkippedOptional>();
  let settled = false;

  function skip(entry: SkippedOptional): void {
    const key = `${entry.name}@${entry.version ?? entry.range}`;
    if (!skipped.has(key)) skipped.set(key, entry);
  }

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
      },
      () => undefined
    );
  }

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
        requester.dependencies[name] = buildNode(name, resolved.version, resolved.entry);
      }
      return;
    }

    const node = buildNode(name, resolved.version, resolved.entry);
    attachNode(top, node, nearest, ancestors);

    const childAncestors: InstallNode[] = [node, ...ancestors];
    const children = edgesOf(resolved.entry);
    for (const child of children) prefetch(child);
    for (const child of children) {
      await place(child, childAncestors);
    }
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
  } finally {
    settled = true;
  }

  return { root: top, skippedOptional: [...skipped.values()] };
}

interface Edge {
  name: string;
  range: string;

  optional: boolean;
}

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
