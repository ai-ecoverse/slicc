/**
 * Pyodide lockfile resolver for `di`.
 *
 * Reads the `pyodide-lock.json` that `ipk add pyodide@<version>` installs at
 * `/workspace/node_modules/pyodide/pyodide-lock.json` and resolves a package
 * name to its CDN-hosted wheel. Lockfile membership is the sole, deterministic
 * signal for the Pyodide-CDN backend — a miss returns `null` so the caller
 * falls through to PyPI (there is no fuzzy fallback).
 *
 * On a fresh VFS that hasn't run `ipk add pyodide` the local copy is absent, so
 * the lockfile is fetched once from the Pyodide CDN and cached for the session.
 * A network/parse failure falls through to `null`, preserving the PyPI
 * last-resort (e.g. offline / CDN outage).
 *
 * The parsed lockfile is cached per `VirtualFS` instance (WeakMap) so repeated
 * `di add` calls in one session don't re-read + re-parse the multi-hundred-KB
 * JSON. Only successful parses are cached; a missing file is not memoized so a
 * later `ipk add pyodide` becomes visible without a restart.
 */

import type { SecureFetch } from 'just-bash';
import { createLogger } from '../../core/logger.js';
import type { VirtualFS } from '../../fs/index.js';
import { PYODIDE_RUNTIME_CDN } from '../../kernel/realm/py-realm-shared.js';
import { decodeFetchBody } from '../fetch-body.js';
import { normalizePackageName } from './manifest.js';
import type { ResolvedPackage } from './types.js';

const log = createLogger('di');

const DEFAULT_TIMEOUT_MS = 30_000;

/** Where `ipk add pyodide@<version>` lands the lockfile in the VFS. */
export const PYODIDE_LOCKFILE_PATH = '/workspace/node_modules/pyodide/pyodide-lock.json';

interface PyodideLockEntry {
  name?: string;
  version?: string;
  file_name?: string;
  sha256?: string;
}

interface PyodideLock {
  packages?: Record<string, PyodideLockEntry>;
}

const lockCache = new WeakMap<VirtualFS, Map<string, PyodideLockEntry>>();

async function loadLockfile(
  fs: VirtualFS,
  fetch: SecureFetch
): Promise<Map<string, PyodideLockEntry> | null> {
  const cached = lockCache.get(fs);
  if (cached) return cached;

  let text: string;
  if (await fs.exists(PYODIDE_LOCKFILE_PATH)) {
    try {
      text = (await fs.readFile(PYODIDE_LOCKFILE_PATH)) as string;
    } catch (err) {
      log.error('failed to read pyodide-lock.json', err);
      return null;
    }
  } else {
    const url = `${PYODIDE_RUNTIME_CDN}pyodide-lock.json`;
    let result: Awaited<ReturnType<SecureFetch>>;
    try {
      result = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      log.error('failed to fetch pyodide-lock.json from CDN', err);
      return null;
    }
    if (result.status < 200 || result.status >= 300) {
      log.error(`pyodide-lock.json CDN fetch returned HTTP ${result.status}`);
      return null;
    }
    text = decodeFetchBody(result.body);
  }

  let parsed: PyodideLock;
  try {
    parsed = JSON.parse(text) as PyodideLock;
  } catch (err) {
    log.error('pyodide-lock.json was not valid JSON', err);
    return null;
  }

  const map = new Map<string, PyodideLockEntry>();
  for (const [key, entry] of Object.entries(parsed.packages ?? {})) {
    if (!entry || typeof entry.file_name !== 'string') continue;
    map.set(normalizePackageName(entry.name ?? key), entry);
  }
  lockCache.set(fs, map);
  return map;
}

/**
 * Resolve `name` (optionally pinned to `version`) against the Pyodide
 * lockfile. Returns `null` when the package is not in the lockfile so the
 * caller can try PyPI. Throws when the package IS in the lockfile but the
 * requested version differs — the Pyodide CDN serves only the locked build.
 */
export async function resolveLockfile(
  fs: VirtualFS,
  fetch: SecureFetch,
  name: string,
  version?: string
): Promise<ResolvedPackage | null> {
  const map = await loadLockfile(fs, fetch);
  if (!map) return null;

  const entry = map.get(normalizePackageName(name));
  if (!entry?.file_name || !entry.version || !entry.sha256) return null;

  if (version && version !== entry.version) {
    throw new Error(
      `di: ${name}==${version} requested but the Pyodide lockfile pins ${entry.name ?? name}==${entry.version} ` +
        `(the Pyodide CDN serves only the locked version — omit the version, or use real uv locally)`
    );
  }

  return {
    name: entry.name ?? name,
    version: entry.version,
    source: 'pyodide-cdn',
    fileName: entry.file_name,
    sha256: entry.sha256,
    url: `${PYODIDE_RUNTIME_CDN}${entry.file_name}`,
  };
}
