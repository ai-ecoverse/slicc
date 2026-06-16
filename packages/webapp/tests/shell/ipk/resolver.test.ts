import { describe, expect, it, vi } from 'vitest';
import type { Packument } from '../../../src/shell/ipk/registry.js';
import {
  type InstallNode,
  type PackumentSupplier,
  resolveDependencyTree,
} from '../../../src/shell/ipk/resolver.js';

interface PackumentInput {
  name: string;
  versions: string[];
  distTags?: Record<string, string>;
  deps?: Record<string, Record<string, string>>;
}

function makePackument(input: PackumentInput): Packument {
  const versionMap: Record<string, unknown> = {};
  for (const v of input.versions) {
    versionMap[v] = {
      name: input.name,
      version: v,
      dist: {
        tarball: `https://registry.npmjs.org/${input.name}/-/${tarballBasename(input.name, v)}`,
      },
      dependencies: input.deps?.[v] ?? {},
    };
  }
  return {
    name: input.name,
    'dist-tags': input.distTags ?? { latest: input.versions[input.versions.length - 1] },
    versions: versionMap as Packument['versions'],
  };
}

function tarballBasename(name: string, version: string): string {
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  return `${base}-${version}.tgz`;
}

function makeSupplier(packuments: PackumentInput[]): PackumentSupplier {
  const byName = new Map<string, Packument>();
  for (const p of packuments) byName.set(p.name, makePackument(p));
  return async (name: string): Promise<Packument> => {
    const p = byName.get(name);
    if (!p) throw new Error(`unknown package: ${name}`);
    return p;
  };
}

function getNode(
  plan: { root: Record<string, InstallNode> },
  name: string
): InstallNode | undefined {
  return plan.root[name];
}

describe('resolveDependencyTree', () => {
  it('returns an empty plan when no roots are provided', async () => {
    const fetchPackument = vi.fn();
    const plan = await resolveDependencyTree({
      rootDependencies: {},
      fetchPackument,
    });
    expect(plan.root).toEqual({});
    expect(fetchPackument).not.toHaveBeenCalled();
  });

  it('resolves a single root dependency to its concrete version at the top level', async () => {
    const supplier = makeSupplier([{ name: 'is-number', versions: ['7.0.0'] }]);
    const plan = await resolveDependencyTree({
      rootDependencies: { 'is-number': '^7.0.0' },
      fetchPackument: supplier,
    });
    const node = getNode(plan, 'is-number');
    expect(node?.version).toBe('7.0.0');
    expect(node?.resolved).toBe('https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz');
    expect(node?.dependencies).toEqual({});
  });

  it('selects the highest version in a caret range against the packument', async () => {
    const supplier = makeSupplier([
      { name: 'pkg', versions: ['1.0.0', '1.2.5', '1.3.0', '2.0.0'] },
    ]);
    const plan = await resolveDependencyTree({
      rootDependencies: { pkg: '^1.2.0' },
      fetchPackument: supplier,
    });
    expect(plan.root.pkg?.version).toBe('1.3.0');
  });

  it('resolves a transitive chain (A -> B -> C) and hoists every node to top-level', async () => {
    const supplier = makeSupplier([
      { name: 'a', versions: ['1.0.0'], deps: { '1.0.0': { b: '^1.0.0' } } },
      { name: 'b', versions: ['1.0.0'], deps: { '1.0.0': { c: '^1.0.0' } } },
      { name: 'c', versions: ['1.0.0'] },
    ]);
    const plan = await resolveDependencyTree({
      rootDependencies: { a: '^1.0.0' },
      fetchPackument: supplier,
    });
    expect(plan.root.a?.version).toBe('1.0.0');
    expect(plan.root.b?.version).toBe('1.0.0');
    expect(plan.root.c?.version).toBe('1.0.0');
    expect(plan.root.a?.dependencies).toEqual({});
    expect(plan.root.b?.dependencies).toEqual({});
    expect(plan.root.c?.dependencies).toEqual({});
  });

  it('dedupes a shared dependency requested at compatible ranges to a single hoisted copy', async () => {
    const supplier = makeSupplier([
      { name: 'left', versions: ['1.0.0'], deps: { '1.0.0': { shared: '^1.0.0' } } },
      { name: 'right', versions: ['1.0.0'], deps: { '1.0.0': { shared: '^1.0.0' } } },
      { name: 'shared', versions: ['1.0.0', '1.2.0'] },
    ]);
    const plan = await resolveDependencyTree({
      rootDependencies: { left: '^1.0.0', right: '^1.0.0' },
      fetchPackument: supplier,
    });
    expect(plan.root.shared?.version).toBe('1.2.0');
    expect(plan.root.left?.dependencies).toEqual({});
    expect(plan.root.right?.dependencies).toEqual({});
  });

  it('nests a conflicting version under the later requester (incompatible ranges)', async () => {
    const supplier = makeSupplier([
      { name: 'left', versions: ['1.0.0'], deps: { '1.0.0': { dep: '^1.0.0' } } },
      { name: 'right', versions: ['1.0.0'], deps: { '1.0.0': { dep: '^2.0.0' } } },
      { name: 'dep', versions: ['1.5.0', '2.0.0'] },
    ]);
    const plan = await resolveDependencyTree({
      rootDependencies: { left: '^1.0.0', right: '^1.0.0' },
      fetchPackument: supplier,
    });

    expect(plan.root.dep?.version).toBe('1.5.0');
    expect(plan.root.left?.dependencies).toEqual({});
    const nested = plan.root.right?.dependencies.dep;
    expect(nested?.version).toBe('2.0.0');
    expect(nested?.dependencies).toEqual({});
  });

  it('reuses an existing top-level entry for compatible transitives without nesting a duplicate', async () => {
    const supplier = makeSupplier([
      { name: 'a', versions: ['1.0.0'], deps: { '1.0.0': { c: '^1.0.0' } } },
      { name: 'b', versions: ['1.0.0'], deps: { '1.0.0': { a: '^1.0.0', c: '^1.0.0' } } },
      { name: 'c', versions: ['1.0.0', '1.2.0'] },
    ]);
    const plan = await resolveDependencyTree({
      rootDependencies: { a: '^1.0.0', b: '^1.0.0' },
      fetchPackument: supplier,
    });

    expect(plan.root.a?.version).toBe('1.0.0');
    expect(plan.root.b?.version).toBe('1.0.0');
    expect(plan.root.c?.version).toBe('1.2.0');
    expect(plan.root.a?.dependencies).toEqual({});
    expect(plan.root.b?.dependencies).toEqual({});
  });

  it('terminates on a direct A <-> B cycle without infinite recursion', async () => {
    const supplier = makeSupplier([
      { name: 'a', versions: ['1.0.0'], deps: { '1.0.0': { b: '^1.0.0' } } },
      { name: 'b', versions: ['1.0.0'], deps: { '1.0.0': { a: '^1.0.0' } } },
    ]);
    const plan = await resolveDependencyTree({
      rootDependencies: { a: '^1.0.0' },
      fetchPackument: supplier,
    });
    expect(plan.root.a?.version).toBe('1.0.0');
    expect(plan.root.b?.version).toBe('1.0.0');
  });

  it('terminates on a longer cycle (A -> B -> C -> A)', async () => {
    const supplier = makeSupplier([
      { name: 'a', versions: ['1.0.0'], deps: { '1.0.0': { b: '^1.0.0' } } },
      { name: 'b', versions: ['1.0.0'], deps: { '1.0.0': { c: '^1.0.0' } } },
      { name: 'c', versions: ['1.0.0'], deps: { '1.0.0': { a: '^1.0.0' } } },
    ]);
    const plan = await resolveDependencyTree({
      rootDependencies: { a: '^1.0.0' },
      fetchPackument: supplier,
    });
    expect(plan.root.a?.version).toBe('1.0.0');
    expect(plan.root.b?.version).toBe('1.0.0');
    expect(plan.root.c?.version).toBe('1.0.0');
  });

  it('terminates on a self-referencing cycle (A -> A)', async () => {
    const supplier = makeSupplier([
      { name: 'a', versions: ['1.0.0'], deps: { '1.0.0': { a: '^1.0.0' } } },
    ]);
    const plan = await resolveDependencyTree({
      rootDependencies: { a: '^1.0.0' },
      fetchPackument: supplier,
    });
    expect(plan.root.a?.version).toBe('1.0.0');
    expect(plan.root.a?.dependencies).toEqual({});
  });

  it('caches packuments and fetches each name only once', async () => {
    const supplier = makeSupplier([
      { name: 'a', versions: ['1.0.0'], deps: { '1.0.0': { shared: '^1.0.0' } } },
      { name: 'b', versions: ['1.0.0'], deps: { '1.0.0': { shared: '^1.0.0' } } },
      { name: 'shared', versions: ['1.0.0'] },
    ]);
    const spy = vi.fn(supplier);
    await resolveDependencyTree({
      rootDependencies: { a: '^1.0.0', b: '^1.0.0' },
      fetchPackument: spy,
    });
    const names = spy.mock.calls.map((c) => c[0]).sort();
    expect(names).toEqual(['a', 'b', 'shared']);
  });

  it('includes scoped-package names verbatim in the install plan', async () => {
    const supplier = makeSupplier([
      { name: '@acme/util', versions: ['1.0.0'], deps: { '1.0.0': { 'is-number': '^7.0.0' } } },
      { name: 'is-number', versions: ['7.0.0'] },
    ]);
    const plan = await resolveDependencyTree({
      rootDependencies: { '@acme/util': '^1.0.0' },
      fetchPackument: supplier,
    });
    expect(plan.root['@acme/util']?.version).toBe('1.0.0');
    expect(plan.root['is-number']?.version).toBe('7.0.0');
  });

  it('propagates dist.integrity onto each install node when present', async () => {
    const packument: Packument = {
      name: 'pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          name: 'pkg',
          version: '1.0.0',
          dist: {
            tarball: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
            integrity: 'sha512-abc',
          },
        },
      },
    };
    const supplier: PackumentSupplier = async () => packument;
    const plan = await resolveDependencyTree({
      rootDependencies: { pkg: '^1.0.0' },
      fetchPackument: supplier,
    });
    expect(plan.root.pkg?.integrity).toBe('sha512-abc');
  });

  it('throws a clear error when a packument fetch fails', async () => {
    const supplier: PackumentSupplier = async (name: string) => {
      throw new Error(`registry: ${name} not found`);
    };
    await expect(
      resolveDependencyTree({
        rootDependencies: { 'missing-pkg': '^1.0.0' },
        fetchPackument: supplier,
      })
    ).rejects.toThrow(/missing-pkg/);
  });

  it('throws when no version satisfies the requested range', async () => {
    const supplier = makeSupplier([{ name: 'pkg', versions: ['1.0.0'] }]);
    await expect(
      resolveDependencyTree({
        rootDependencies: { pkg: '^99.0.0' },
        fetchPackument: supplier,
      })
    ).rejects.toThrow(/no version satisfies|satisfies|matching/i);
  });

  it('throws when the resolved version is missing dist.tarball', async () => {
    const packument: Packument = {
      name: 'pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          name: 'pkg',
          version: '1.0.0',
          dist: { tarball: '' },
        },
      },
    };
    const supplier: PackumentSupplier = async () => packument;
    await expect(
      resolveDependencyTree({
        rootDependencies: { pkg: '^1.0.0' },
        fetchPackument: supplier,
      })
    ).rejects.toThrow(/tarball/i);
  });
});
