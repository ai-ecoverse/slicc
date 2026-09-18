import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function discoverWorkspacePackages(tree) {
  const packages = new Map();
  let roots;
  try {
    roots = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).workspaces ?? [];
  } catch {
    return packages;
  }
  for (const rel of roots) {
    const dir = join(tree, rel);
    try {
      const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
      if (name) packages.set(name, dir);
    } catch {}
  }
  return packages;
}

export function linkNodeModules(repoRoot, tree) {
  const realNm = resolve(repoRoot, 'node_modules');
  const treeNm = join(tree, 'node_modules');
  const workspaces = discoverWorkspacePackages(tree);
  const scopes = new Set(
    [...workspaces.keys()].filter((n) => n.startsWith('@')).map((n) => n.split('/')[0])
  );

  mkdirSync(treeNm, { recursive: true });
  for (const entry of readdirSync(realNm)) {
    if (scopes.has(entry)) continue;
    const target = workspaces.get(entry) ?? join(realNm, entry);
    symlinkSync(target, join(treeNm, entry), 'dir');
  }
  for (const scope of scopes) {
    const realScope = join(realNm, scope);
    if (!existsSync(realScope)) continue;
    mkdirSync(join(treeNm, scope), { recursive: true });
    for (const child of readdirSync(realScope)) {
      const target = workspaces.get(`${scope}/${child}`) ?? join(realScope, child);
      symlinkSync(target, join(treeNm, scope, child), 'dir');
    }
  }

  for (const dir of workspaces.values()) {
    const rel = dir.slice(tree.length + 1);
    const realPkgNm = resolve(repoRoot, rel, 'node_modules');
    if (existsSync(realPkgNm)) symlinkSync(realPkgNm, join(dir, 'node_modules'), 'dir');
  }
}

function readLockPackages(tree) {
  try {
    return JSON.parse(readFileSync(join(tree, 'package-lock.json'), 'utf8')).packages ?? null;
  } catch {
    return null;
  }
}

function lockInstallRegistryName(installName) {
  const nested = installName.lastIndexOf('/node_modules/');
  return nested === -1 ? installName : installName.slice(nested + '/node_modules/'.length);
}

function isDefinitelyTypedPackage(installName) {
  return lockInstallRegistryName(installName).startsWith('@types/');
}

function nestedCopyIsCovered(path, entry, _base, head) {
  if (isDefinitelyTypedPackage(path.slice('node_modules/'.length))) return true;
  const headEntry = head[path];
  return entry.dev === true && (headEntry == null || headEntry.dev === true);
}

function registryName(path, entry) {
  if (entry.name) return entry.name;
  const installName = path.slice('node_modules/'.length);
  const idx = installName.lastIndexOf('/node_modules/');
  return idx === -1 ? installName : installName.slice(idx + '/node_modules/'.length);
}

export function dependencyDrift(repoRoot, tree) {
  const head = readLockPackages(repoRoot);
  const base = readLockPackages(tree);
  if (!head || !base) return null;

  const workspaces = new Set(discoverWorkspacePackages(tree).keys());
  const changed = [];
  const missing = [];
  const unrealignable = [];
  for (const [path, entry] of Object.entries(base)) {
    if (!path.startsWith('node_modules/')) continue;
    const from = entry?.version;
    if (!from) continue;
    const to = head[path]?.version ?? null;
    if (to === from) continue;
    const installName = path.slice('node_modules/'.length);
    if (installName.includes('/node_modules/')) {
      if (nestedCopyIsCovered(path, entry, base, head)) continue;

      const drift = { path, name: registryName(path, entry), from, to };
      (to === null ? missing : changed).push(drift);
      continue;
    }

    if (workspaces.has(installName)) continue;

    if (isDefinitelyTypedPackage(installName)) continue;

    const drift = { path, name: registryName(path, entry), from, to };
    (to === null ? missing : changed).push(drift);
  }
  appendNestedUnderSwappedParents(changed, missing, base, head);
  return { changed, missing, unrealignable };
}

function appendNestedUnderSwappedParents(changed, missing, base, head) {
  const swappedParents = [...changed, ...missing].map((d) => d.path);
  const already = new Set(swappedParents);
  for (const [path, entry] of Object.entries(base)) {
    if (!path.startsWith('node_modules/') || !path.includes('/node_modules/')) continue;
    if (already.has(path)) continue;
    const from = entry?.version;
    if (!from) continue;
    if (nestedCopyIsCovered(path, entry, base, head)) continue;
    if (!swappedParents.some((parent) => path.startsWith(`${parent}/node_modules/`))) {
      continue;
    }
    const to = head[path]?.version ?? null;
    const drift = { path, name: registryName(path, entry), from, to };
    (to === null ? missing : changed).push(drift);
    already.add(path);
  }
}

export function materializeLinkedParents(nodeModules, relPath) {
  const segments = relPath.split('/');
  let current = nodeModules;

  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });

    if (!stat) {
      mkdirSync(current, { recursive: true });
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = realpathSync(current);
    rmSync(current, { force: true });
    mkdirSync(current, { recursive: true });
    for (const child of readdirSync(target)) {
      symlinkSync(join(target, child), join(current, child), 'dir');
    }
  }
}

const MAX_REALIGNABLE_DRIFT = 25;

function installBaseVersion(tree, staging, { path, name, from }, log) {
  const spec = `${name}@${from}`;
  const packed = run(
    'npm',
    ['pack', spec, '--pack-destination', staging, '--silent', '--no-audit', '--no-fund'],
    { cwd: tree }
  );
  const tarballName = (packed ?? '').split('\n').pop()?.trim();
  if (!tarballName) {
    log(`could not fetch ${spec} for the baseline (npm pack failed)`);
    return false;
  }
  const tarball = existsSync(tarballName) ? tarballName : join(staging, tarballName);
  if (!existsSync(tarball)) {
    log(`could not fetch ${spec} for the baseline (npm pack failed)`);
    return false;
  }
  const unpacked = join(staging, `unpacked-${path.replace(/[@/]/g, '_')}`);
  mkdirSync(unpacked, { recursive: true });
  if (run('tar', ['-xzf', tarball, '-C', unpacked], { cwd: tree }) === null) {
    log(`could not unpack ${spec} for the baseline`);
    return false;
  }
  const pkgDir = join(unpacked, 'package');
  if (!existsSync(pkgDir)) {
    log(`could not unpack ${spec} for the baseline (tarball had no package/ directory)`);
    return false;
  }
  const dest = join(tree, path);

  materializeLinkedParents(join(tree, 'node_modules'), path.slice('node_modules/'.length));

  rmSync(dest, { force: true, recursive: true });
  renameSync(pkgDir, dest);
  return true;
}

export function realignDriftedDependencies(tree, drift, log = () => {}) {
  const changed = drift.changed ?? [];
  const missing = drift.missing ?? [];
  const total = changed.length + missing.length;
  if (total === 0) return true;
  if (total > MAX_REALIGNABLE_DRIFT) {
    log(
      `${total} dependencies differ from the base lockfile (limit ${MAX_REALIGNABLE_DRIFT}) — ` +
        `too many to attribute a size delta to one change`
    );
    return false;
  }
  const staging = mkdtempSync(join(tmpdir(), 'slicc-first-load-pack-'));
  try {
    const byDepth = (a, b) =>
      a.path.split('/node_modules/').length - b.path.split('/node_modules/').length;
    for (const entry of [...changed].sort(byDepth)) {
      if (!installBaseVersion(tree, staging, entry, log)) return false;
      log(`realigned ${entry.name} to the base version ${entry.from} (HEAD has ${entry.to})`);
    }
    for (const entry of [...missing].sort(byDepth)) {
      if (installBaseVersion(tree, staging, entry, log)) {
        log(`restored ${entry.name}@${entry.from}, which this change removes`);
      } else {
        log(
          `could not restore ${entry.name}@${entry.from} (removed by this change); continuing — ` +
            `the base build fails on its own if it actually needed it`
        );
      }
    }
    return true;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) return null;
  return (res.stdout ?? '').trim();
}

const BASE_REF_NAME = /^[A-Za-z0-9._/-]+$/;

export function resolveBaselineRef({ args = [], env = {} } = {}) {
  const flagged = args.find((a) => typeof a === 'string' && a.startsWith('--baseline='));
  if (flagged !== undefined) return flagged.slice('--baseline='.length);

  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    const name = String(env.GITHUB_BASE_REF ?? '');
    if (!name || name.includes('..') || !BASE_REF_NAME.test(name)) {
      throw new Error(
        `GITHUB_BASE_REF must be a safe branch name so the per-change delta can be measured; got ${JSON.stringify(name)}`
      );
    }
    return `origin/${name}`;
  }
  return 'origin/main';
}

export function resolveMergeBase(repoRoot, ref) {
  const opts = { cwd: repoRoot };
  if (run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], opts) === null) {
    return null;
  }
  return run('git', ['merge-base', 'HEAD', ref], opts);
}

export function prerequisiteWorkspaceBuilds(tree) {
  let postinstall;
  try {
    postinstall = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).scripts?.postinstall;
  } catch {
    return [];
  }
  if (typeof postinstall !== 'string') return [];
  const names = [];

  const re = /npm run build -w (@?[\w./-]+)/g;
  let m;
  while ((m = re.exec(postinstall)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

export function measureAtCommit({ repoRoot, sha, measure, log = () => {} }) {
  const tmp = mkdtempSync(join(tmpdir(), 'slicc-first-load-'));
  const tree = join(tmp, 'tree');
  try {
    if (run('git', ['worktree', 'add', '--detach', tree, sha], { cwd: repoRoot }) === null) {
      log(`could not create a worktree at ${sha}`);
      return null;
    }
    linkNodeModules(repoRoot, tree);

    const drift = dependencyDrift(repoRoot, tree);
    if (!drift) {
      log(`could not read the lockfiles to check for dependency drift at ${sha}`);
      return null;
    }
    if (drift.unrealignable.length > 0) {
      log(
        `dependencies drifted at paths the baseline cannot realign, so its size is not ` +
          `comparable: ${drift.unrealignable.join(', ')}`
      );
      return null;
    }
    if (!realignDriftedDependencies(tree, drift, log)) return null;
    const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' };
    const npmRun = (args) => spawnSync('npm', args, { cwd: tree, encoding: 'utf8', env });
    for (const workspace of prerequisiteWorkspaceBuilds(tree)) {
      const pre = npmRun(['run', 'build', '-w', workspace]);
      if (pre.status !== 0) {
        log(
          `baseline prerequisite ${workspace} failed at ${sha}:\n${(pre.stderr ?? '').slice(-1500)}`
        );
        return null;
      }
    }
    const built = npmRun(['run', 'build', '-w', '@slicc/webapp']);
    if (built.status !== 0) {
      log(`baseline build failed at ${sha}:\n${(built.stderr ?? '').slice(-2000)}`);
      return null;
    }
    const uiDir = join(tree, 'dist/ui');
    if (!existsSync(uiDir)) {
      log(`baseline build at ${sha} produced no dist/ui`);
      return null;
    }
    return measure(uiDir);
  } finally {
    run('git', ['worktree', 'remove', '--force', tree], { cwd: repoRoot });
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function measureMergeBase({ repoRoot, ref, measure, log = () => {} }) {
  const sha = resolveMergeBase(repoRoot, ref);
  if (!sha) {
    log(`could not resolve a merge base with "${ref}" (unknown ref, or a shallow clone)`);
    return null;
  }
  const bytes = measureAtCommit({ repoRoot, sha, measure, log });
  return bytes ? { sha, bytes } : null;
}
