/**
 * PyPI JSON-API resolver for `di`.
 *
 * The PyPI backend handles every package NOT in the Pyodide lockfile. It
 * resolves `name[==version]` via `GET https://pypi.org/pypi/<name>/json` (or
 * `.../<name>/<version>/json`) and selects the first `bdist_wheel` whose
 * platform tag is `any` — i.e. a pure-Python `*-none-any.whl`. Platform-
 * specific (compiled) wheels are rejected with an actionable error; their
 * native extensions can't run under Pyodide and are out of scope for the
 * SLICC di subset.
 */

import type { SecureFetch } from 'just-bash';
import { decodeFetchBody } from '../fetch-body.js';
import type { ResolvedPackage } from './types.js';

const PYPI_HOST = 'pypi.org';
const DEFAULT_TIMEOUT_MS = 30_000;

interface PypiUrlEntry {
  packagetype?: string;
  filename?: string;
  url?: string;
  digests?: { sha256?: string };
}

interface PypiResponse {
  info?: { name?: string; version?: string };
  urls?: PypiUrlEntry[];
}

function pypiJsonUrl(name: string, version?: string): string {
  const base = `https://${PYPI_HOST}/pypi/${encodeURIComponent(name)}`;
  return version ? `${base}/${encodeURIComponent(version)}/json` : `${base}/json`;
}

/**
 * The platform tag of a wheel filename — the last of the three
 * `python-abi-platform` tags before `.whl`. Returns `null` when `filename`
 * is not a well-formed wheel name. Pure-Python wheels have platform `any`.
 */
function wheelPlatformTag(filename: string): string | null {
  if (!filename.endsWith('.whl')) return null;
  const parts = filename.slice(0, -'.whl'.length).split('-');
  if (parts.length < 3) return null;
  return parts[parts.length - 1];
}

/**
 * Resolve `name` (optionally pinned to `version`) against PyPI. Throws a clear
 * error on 404, transport failure, malformed JSON, a missing version, no wheel
 * at all (sdist-only), or only platform-specific wheels.
 */
export async function resolvePypi(
  fetch: SecureFetch,
  name: string,
  version?: string
): Promise<ResolvedPackage> {
  const label = `di: PyPI lookup for ${name}${version ? `==${version}` : ''}`;
  const url = pypiJsonUrl(name, version);

  let result: Awaited<ReturnType<SecureFetch>>;
  try {
    result = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: network error (${reason})`);
  }

  if (result.status === 404) {
    throw new Error(
      `di: package '${name}'${version ? ` version '${version}'` : ''} not found on PyPI`
    );
  }
  if (result.status < 200 || result.status >= 300) {
    const statusText = result.statusText ? ` ${result.statusText}` : '';
    throw new Error(`${label} returned HTTP ${result.status}${statusText}`);
  }

  let parsed: PypiResponse;
  try {
    parsed = JSON.parse(decodeFetchBody(result.body)) as PypiResponse;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: response was not valid JSON (${reason})`);
  }

  const resolvedName = parsed.info?.name ?? name;
  const resolvedVersion = parsed.info?.version ?? version;
  if (!resolvedVersion) {
    throw new Error(`${label}: PyPI did not report a version for '${name}'`);
  }

  const wheels = (parsed.urls ?? []).filter(
    (u): u is PypiUrlEntry & { filename: string; url: string } =>
      u.packagetype === 'bdist_wheel' && typeof u.filename === 'string' && typeof u.url === 'string'
  );
  if (wheels.length === 0) {
    throw new Error(
      `di: ${resolvedName}==${resolvedVersion} has no wheel on PyPI ` +
        `(sdist/source-only packages are not supported in SLICC's di subset — use real uv locally)`
    );
  }

  const pure = wheels.find((u) => wheelPlatformTag(u.filename) === 'any');
  if (!pure) {
    const names = wheels.map((w) => w.filename).join(', ');
    throw new Error(
      `di: ${resolvedName}==${resolvedVersion} only ships platform-specific wheels (${names}); ` +
        `SLICC's di subset installs pure-Python (none-any) wheels only — use real uv locally for compiled packages`
    );
  }

  const sha256 = pure.digests?.sha256;
  if (!sha256) {
    throw new Error(`di: PyPI did not provide a sha256 digest for ${pure.filename}`);
  }

  return {
    name: resolvedName,
    version: resolvedVersion,
    source: 'pypi',
    fileName: pure.filename,
    sha256,
    url: pure.url,
  };
}
