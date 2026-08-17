#!/usr/bin/env node
// Unused-dependency gate for the Swift/SPM packages.
//
// Parity with the other two toolchains: knip covers the TS workspaces
// (`npm run deadcode`) and `go mod tidy -diff` covers the Go modules
// (`make tidy-check` in packages/{go-optel,slicc-cli}). SPM has no built-in
// equivalent, so this walks every `packages/*/Package.swift`, resolves each
// target's sources, and compares the declared dependency graph against the
// modules the sources actually import. Findings:
//
//   unused-package-dependency  `.package(...)` no target consumes
//   unused-target-dependency   target dependency no source of it imports
//   unlisted-dependency        module imported but only reachable transitively
//
// A legitimate exception is annotated at the declaration site with
// `// unused-dep-ok: <reason>` (on the entry's line, any line it spans, or
// the line above it).
//
// String-level by design: the gate runs in the Linux `lint` job, which has no
// Swift toolchain and therefore cannot evaluate Package.swift as code.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  analyzeManifest,
  collectImports,
  parseManifest,
  vendedModules,
} from './check-swift-unused-deps-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');

/** Directories never scanned for target sources. */
const SKIP_DIRS = new Set(['.build', '.swiftpm', 'node_modules', 'dist', 'DerivedData']);

/** Every Package.swift under packages/, sorted for stable output. */
export function findManifests(root = repoRoot) {
  const packagesDir = resolve(root, 'packages');
  const out = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = resolve(packagesDir, entry.name, 'Package.swift');
    if (existsSync(manifest)) out.push(manifest);
  }
  return out.sort();
}

function listSwiftFiles(dir, excluded) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (excluded.has(abs)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...listSwiftFiles(abs, excluded));
    } else if (entry.isFile() && entry.name.endsWith('.swift')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Resolve a target's source directory the way SPM does: the explicit `path:`
 * when given, else the conventional `Sources/<name>` / `Tests/<name>` layout.
 */
export function targetSourceRoots(pkgDir, target) {
  if (target.path) return [resolve(pkgDir, target.path)];
  const conventional = target.isTest
    ? [`Tests/${target.name}`, 'Tests']
    : [`Sources/${target.name}`, 'Sources', 'Source', 'src', target.name];
  return conventional.map((p) => resolve(pkgDir, p)).filter((p) => existsSync(p));
}

/** Union of the modules imported by every source file of `target`. */
function importsForTarget(pkgDir, target) {
  const roots = targetSourceRoots(pkgDir, target);
  const excluded = new Set();
  for (const root of roots) {
    for (const rel of target.exclude) excluded.add(resolve(root, rel));
  }
  const files = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (statSync(root).isFile()) files.push(root);
    else files.push(...listSwiftFiles(root, excluded));
  }
  // `sources:` narrows a target to an explicit file/dir subset.
  const filtered =
    target.sources.length === 0
      ? files
      : files.filter((f) =>
          target.sources.some((s) =>
            roots.some((root) => {
              const abs = resolve(root, s);
              return f === abs || f.startsWith(`${abs}/`);
            })
          )
        );
  const modules = new Set();
  for (const file of filtered) {
    for (const m of collectImports(readFileSync(file, 'utf8'))) modules.add(m);
  }
  return { modules, fileCount: filtered.length };
}

/**
 * Parse every manifest, then analyse each against its sources.
 * Returns `{ packages, findings }` with findings carrying a repo-relative file.
 */
export function checkRepo(root = repoRoot) {
  const manifests = findManifests(root);
  const parsed = new Map();
  for (const abs of manifests) {
    parsed.set(abs, parseManifest(readFileSync(abs, 'utf8')));
  }

  // Module sets for local (`path:`) dependencies, so a product that vends a
  // differently-named module — and the unlisted-import check — resolve.
  const modulesByDir = new Map();
  for (const [abs, manifest] of parsed) modulesByDir.set(dirname(abs), vendedModules(manifest));

  const findings = [];
  const packages = [];
  for (const [abs, manifest] of parsed) {
    const pkgDir = dirname(abs);
    const localModulesByPackage = new Map();
    for (const dep of manifest.dependencies) {
      if (dep.kind !== 'path' || !dep.path) continue;
      const depDir = resolve(pkgDir, dep.path);
      const modules = modulesByDir.get(depDir);
      if (modules) localModulesByPackage.set(dep.identity.toLowerCase(), modules);
    }

    const importsByTarget = new Map();
    let scannedFiles = 0;
    for (const target of manifest.targets) {
      if (!target.hasSources) continue;
      const { modules, fileCount } = importsForTarget(pkgDir, target);
      scannedFiles += fileCount;
      if (fileCount === 0) {
        findings.push({
          file: relative(root, abs),
          severity: 'error',
          code: 'unresolved-target-sources',
          line: target.line,
          message:
            `target '${target.name}' resolved to no Swift sources — the gate ` +
            'cannot verify its dependencies (check `path:`/`sources:`)',
        });
        continue;
      }
      importsByTarget.set(target.name, modules);
    }

    for (const finding of analyzeManifest({ manifest, importsByTarget, localModulesByPackage })) {
      findings.push({ file: relative(root, abs), ...finding });
    }
    packages.push({
      name: manifest.packageName,
      file: relative(root, abs),
      targets: manifest.targets.length,
      dependencies: manifest.dependencies.length,
      scannedFiles,
    });
  }
  return { packages, findings };
}

function main() {
  // `--root <dir>` scans an alternate tree; the tests use it to drive the CLI
  // over a scratch layout without touching the checked-in manifests.
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag === -1 ? repoRoot : resolve(argv[rootFlag + 1] ?? '');
  let result;
  try {
    result = checkRepo(root);
  } catch (err) {
    stderr.write(`::error::check-swift-unused-deps failed: ${err.message}\n`);
    exit(2);
  }
  const { packages, findings } = result;

  if (findings.length > 0) {
    for (const f of findings) {
      stderr.write(`::error file=${f.file},line=${f.line}::${f.code}: ${f.message}\n`);
    }
    stderr.write(
      `\n${findings.length} Swift dependency issue(s) across ${packages.length} package(s).\n`
    );
    exit(1);
  }

  const targets = packages.reduce((n, p) => n + p.targets, 0);
  const deps = packages.reduce((n, p) => n + p.dependencies, 0);
  const files = packages.reduce((n, p) => n + p.scannedFiles, 0);
  stdout.write(
    `ok: ${deps} SPM package dependencies across ${packages.length} manifests / ` +
      `${targets} targets are all imported (${files} Swift files scanned)\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
