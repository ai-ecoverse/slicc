import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const packagerSource = readFileSync(
  join(repoRoot, 'packages/node-server/scripts/inline-workspaces.mjs'),
  'utf8'
);
const INLINED_PACKAGES = new Set(
  [...packagerSource.matchAll(/packageName: '(@slicc\/[^']+)'/g)].map((m) => m[1] as string)
);
const RUNTIME_SOURCE_DIRS = [
  'packages/node-server/src',
  ...[...packagerSource.matchAll(/packages\/([^/']+)\/dist/g)].map((m) => `packages/${m[1]}/src`),
];

const BUILTINS = new Set(builtinModules);

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  const staticRe = /(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gs;
  for (const match of source.matchAll(staticRe)) {
    if (!match[1]) specifiers.push(match[2] as string);
  }

  const bareRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)|^import\s+['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(bareRe)) {
    specifiers.push((match[1] ?? match[2]) as string);
  }
  return specifiers.filter((spec) => !spec.startsWith('.') && !spec.startsWith('node:'));
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
}

describe('e2b template node version', () => {
  it('pins a node version that satisfies root engines.node', () => {
    const templateSource = readFileSync(
      join(repoRoot, 'packages/dev-tools/e2b-template/template.ts'),
      'utf8'
    );
    const pinMatch = /const nodeVersion = '(\d+)\.(\d+)\.(\d+)'/.exec(templateSource);
    expect(pinMatch, "template.ts must pin `const nodeVersion = 'x.y.z'`").not.toBeNull();

    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      engines: { node: string };
    };
    const engineMatch = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(rootPkg.engines.node);
    expect(engineMatch, 'expected root engines.node of the form >=x.y.z').not.toBeNull();

    const toTuple = (m: RegExpExecArray): [number, number, number] => [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
    ];
    const pinned = toTuple(pinMatch as RegExpExecArray);
    const minimum = toTuple(engineMatch as RegExpExecArray);
    const cmp = pinned[0] - minimum[0] || pinned[1] - minimum[1] || pinned[2] - minimum[2];
    expect(
      cmp >= 0,
      `template.ts pins node ${pinned.join('.')} but root engines.node requires ${rootPkg.engines.node}`
    ).toBe(true);
  });
});

describe('e2b hosted-leader runtime dependencies', () => {
  it('lists every third-party runtime import in runtime-package.json', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'packages/dev-tools/e2b-template/runtime-package.json'), 'utf8')
    ) as { dependencies: Record<string, string> };
    const installed = new Set(Object.keys(manifest.dependencies));

    const required = new Set<string>();
    const nonInlinedWorkspaceImports = new Set<string>();
    for (const dir of RUNTIME_SOURCE_DIRS) {
      for (const file of listTsFiles(join(repoRoot, dir))) {
        for (const spec of valueImportSpecifiers(readFileSync(file, 'utf8'))) {
          const name = packageName(spec);
          if (BUILTINS.has(name) || INLINED_PACKAGES.has(name)) continue;
          if (name.startsWith('@slicc/')) {
            nonInlinedWorkspaceImports.add(name);
            continue;
          }
          required.add(name);
        }
      }
    }

    expect(
      [...nonInlinedWorkspaceImports].sort(),
      'workspaces value-imported by the hosted leader but not inlined by scripts/inline-workspaces.mjs (add them to its WORKSPACES array)'
    ).toEqual([]);

    const missing = [...required].filter((name) => !installed.has(name)).sort();
    expect(
      missing,
      `packages imported by the hosted leader but not installed in the E2B sandbox (add to packages/dev-tools/e2b-template/runtime-package.json and rebuild the template): ${missing.join(', ')}`
    ).toEqual([]);
  });
});
