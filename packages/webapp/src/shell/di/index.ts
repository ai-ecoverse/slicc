/**
 * `di` orchestration — resolves, stages, and records Python wheels.
 *
 * `diAdd` resolves each spec (Pyodide lockfile first, then PyPI), downloads
 * and sha256-verifies the wheel, stages it flat under `/workspace/python_wheels/`,
 * then records every success in `pyproject.toml` + `uv.lock` next to the nearest
 * discovered manifest. Verification happens before any VFS write, so a digest
 * mismatch never leaves a partial wheel or manifest entry behind.
 *
 * `diList` is a pure read of the discovered manifest pair.
 */

import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { joinPath } from '../../fs/path-utils.js';
import { fetchAndVerify, sha256Hex } from './fetcher.js';
import { resolveLockfile } from './lockfile.js';
import {
  findManifestDir,
  type LockEntry,
  loadPyproject,
  loadUvLock,
  normalizePackageName,
  resolveManifestDir,
  savePyproject,
  saveUvLock,
  splitDependency,
  upsertDependency,
  upsertLockEntry,
} from './manifest.js';
import { resolvePypi } from './pypi.js';
import type { ParsedSpec, ResolvedPackage } from './types.js';

/** Flat staging directory for all wheels, regardless of manifest location. */
export const WHEELS_DIR = '/workspace/python_wheels';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parse a `di add` spec: `name`, `name@version`, or `name==version`. */
export function parseSpec(spec: string): ParsedSpec {
  const s = spec.trim();
  if (!s) throw new Error('di: package spec is required');

  let name = s;
  let version: string | undefined;
  const eqeq = s.indexOf('==');
  if (eqeq !== -1) {
    name = s.slice(0, eqeq);
    version = s.slice(eqeq + 2);
  } else {
    const at = s.indexOf('@');
    if (at !== -1) {
      name = s.slice(0, at);
      version = s.slice(at + 1);
    }
  }
  name = name.trim();
  version = version?.trim();
  if (!NAME_RE.test(name)) {
    throw new Error(`di: invalid package name '${name}'`);
  }
  if (version !== undefined && version === '') {
    throw new Error(`di: empty version in spec '${spec}'`);
  }
  return { name, version };
}

export interface AddResult {
  name: string;
  version: string;
  source: ResolvedPackage['source'];
  fileName: string;
  sha256: string;
  /** `false` when a byte-identical wheel was already staged (no-op). */
  staged: boolean;
}

export interface AddOutcome {
  results: AddResult[];
  errors: { spec: string; error: Error }[];
  manifestDir: string;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function resolvePackage(
  fs: VirtualFS,
  fetch: SecureFetch,
  spec: ParsedSpec
): Promise<ResolvedPackage> {
  const fromLock = await resolveLockfile(fs, spec.name, spec.version);
  if (fromLock) return fromLock;
  return resolvePypi(fetch, spec.name, spec.version);
}

async function addOne(fs: VirtualFS, fetch: SecureFetch, spec: ParsedSpec): Promise<AddResult> {
  const pkg = await resolvePackage(fs, fetch, spec);
  const bytes = await fetchAndVerify(fetch, {
    url: pkg.url,
    sha256: pkg.sha256,
    label: `di: download ${pkg.name}==${pkg.version}`,
  });

  await fs.mkdir(WHEELS_DIR, { recursive: true });
  const target = joinPath(WHEELS_DIR, pkg.fileName);
  let staged = true;
  if (await fs.exists(target)) {
    const existing = (await fs.readFile(target, { encoding: 'binary' })) as Uint8Array;
    const existingSha = await sha256Hex(existing);
    if (existingSha === pkg.sha256.toLowerCase()) {
      staged = false;
    } else {
      throw new Error(
        `di: ${pkg.fileName} is already staged with different bytes ` +
          `(sha256 ${existingSha} != ${pkg.sha256.toLowerCase()}); refusing to overwrite`
      );
    }
  } else {
    await fs.writeFile(target, bytes);
  }

  return {
    name: pkg.name,
    version: pkg.version,
    source: pkg.source,
    fileName: pkg.fileName,
    sha256: pkg.sha256,
    staged,
  };
}

/** Resolve, stage, and record every spec. Per-spec failures are collected. */
export async function diAdd(
  fs: VirtualFS,
  fetch: SecureFetch,
  cwd: string,
  specs: string[]
): Promise<AddOutcome> {
  const manifestDir = await resolveManifestDir(fs, cwd);
  const results: AddResult[] = [];
  const errors: { spec: string; error: Error }[] = [];

  for (const raw of specs) {
    let spec: ParsedSpec;
    try {
      spec = parseSpec(raw);
    } catch (err) {
      errors.push({ spec: raw, error: toError(err) });
      continue;
    }
    try {
      results.push(await addOne(fs, fetch, spec));
    } catch (err) {
      errors.push({ spec: raw, error: toError(err) });
    }
  }

  if (results.length > 0) {
    const project = await loadPyproject(fs, manifestDir);
    let deps = project.dependencies;
    let lock = await loadUvLock(fs, manifestDir);
    for (const r of results) {
      deps = upsertDependency(deps, r.name, r.version);
      lock = upsertLockEntry(lock, {
        name: r.name,
        version: r.version,
        source: r.source,
        fileName: r.fileName,
        sha256: r.sha256,
      } satisfies LockEntry);
    }
    await savePyproject(fs, manifestDir, { ...project, dependencies: deps });
    await saveUvLock(fs, manifestDir, lock);
  }

  return { results, errors, manifestDir };
}

export interface ListRow {
  name: string;
  version: string;
  source: string;
}

/**
 * Read the discovered manifest pair. Returns `null` when no `pyproject.toml`
 * exists up the tree from `cwd`. No network.
 */
export async function diList(fs: VirtualFS, cwd: string): Promise<ListRow[] | null> {
  const dir = await findManifestDir(fs, cwd);
  if (!dir) return null;
  const project = await loadPyproject(fs, dir);
  const lock = await loadUvLock(fs, dir);
  const lockByName = new Map(lock.map((e) => [normalizePackageName(e.name), e]));
  return project.dependencies.map((dep) => {
    const { name, version } = splitDependency(dep);
    const entry = lockByName.get(normalizePackageName(name));
    return {
      name,
      version: version || entry?.version || '?',
      source: entry?.source ?? 'unknown',
    };
  });
}
