/**
 * npm registry client for ipk (Ice Pack).
 *
 * Pure, dependency-light, individually unit-testable. Takes an injected
 * `SecureFetch` so it works in both floats (CLI worker + extension sandbox)
 * and in unit tests. The registry host is composed via `cdn-url-builder`'s
 * token-host pattern so no full `registry.npmjs.org` URL literal appears
 * in the bundle (MV3 remote-hosted-code guard).
 *
 * Every network call is bounded by a timeout and surfaces clear errors.
 */

import type { SecureFetch } from 'just-bash';
import { decodeFetchBody, getFetchBodyBytes } from '../fetch-body.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

import {
  registryUrl as buildRegistryUrl,
  REGISTRY_NPMJS_HOST as REGISTRY_HOST_INTERNAL,
  validateNpmPackageName,
} from '../supplemental-commands/cdn-url-builder.js';
import { isValidRange, maxSatisfying } from './semver.js';

export const REGISTRY_NPMJS_HOST = REGISTRY_HOST_INTERNAL;
export const EXPECTED_TARBALL_HOST = REGISTRY_HOST_INTERNAL;
export const registryUrl = buildRegistryUrl;
export { validateNpmPackageName };

const DEFAULT_TIMEOUT_MS = 30_000;

export interface PackumentDistTags {
  latest?: string;
  [tag: string]: string | undefined;
}

export interface PackumentVersionDist {
  tarball: string;
  integrity?: string;
  shasum?: string;
  [key: string]: unknown;
}

export interface PackumentVersion {
  name: string;
  version: string;
  dist: PackumentVersionDist;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundleDependencies?: string[] | boolean;
  main?: string;
  module?: string;
  type?: 'module' | 'commonjs';
  exports?: unknown;
  bin?: string | Record<string, string>;
  [key: string]: unknown;
}

export interface Packument {
  name: string;
  'dist-tags'?: PackumentDistTags;
  versions: Record<string, PackumentVersion>;
  [key: string]: unknown;
}

export interface RegistryFetchOptions {
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: timed out after ${ms}ms`)),
      Math.max(1, ms)
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

function describeStatus(result: FetchResult, fallback: string): string {
  const statusText = result.statusText ? ` ${result.statusText}` : '';
  return `${fallback} returned HTTP ${result.status}${statusText}`.trim();
}

/**
 * GET `https://registry.npmjs.org/<name>` via the injected `SecureFetch`
 * and return the parsed packument JSON. Bounded by `opts.timeoutMs`
 * (default 30s); surfaces a clear error on non-2xx, malformed JSON,
 * empty response, or timeout.
 */
export async function fetchPackument(
  name: string,
  fetch: SecureFetch,
  opts: RegistryFetchOptions = {}
): Promise<Packument> {
  if (!name || typeof name !== 'string') {
    throw new Error('fetchPackument: package name is required');
  }
  const label = `fetchPackument(${name})`;
  const built = registryUrl(name);
  if (built.host !== REGISTRY_NPMJS_HOST) {
    throw new Error(
      `${label}: refused to fetch packument from host '${built.host}' (expected '${REGISTRY_NPMJS_HOST}')`
    );
  }
  const url = built.toString();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let result: FetchResult;
  try {
    result = await withTimeout(
      fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeoutMs,
      }),
      timeoutMs,
      label
    );
  } catch (err) {
    if (err instanceof Error && /timed out/.test(err.message)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: network error (${reason})`);
  }

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${label}: ${describeStatus(result, 'registry')}`);
  }

  let text: string;
  try {
    text = decodeFetchBody(result.body);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: failed to decode response body (${reason})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: registry response was not valid JSON (${reason})`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${label}: packument was empty or malformed`);
  }
  const packument = parsed as Packument;
  if (!packument.versions || typeof packument.versions !== 'object') {
    throw new Error(`${label}: packument is missing the 'versions' object`);
  }
  return packument;
}

function isLikelyDistTag(spec: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(spec);
}

/**
 * Pick the version that best satisfies `range` against a packument.
 *
 * Resolution order, matching npm's behavior closely enough for ipk:
 *   1. Empty / "*" / "latest" → the `latest` dist-tag.
 *   2. Exact version present in `packument.versions` → that version.
 *   3. A name matching a dist-tag entry → the version it points at.
 *   4. Otherwise: maxSatisfying() against the available versions.
 *
 * Throws a clear error when the packument is empty, the dist-tag points at a
 * missing version, or no version satisfies the supplied range.
 */
interface ResolveContext {
  packageName: string;
  versionMap: Record<string, PackumentVersion>;
  distTags: PackumentDistTags;
  versions: string[];
}

function buildResolveContext(packument: Packument): ResolveContext {
  if (!packument || typeof packument !== 'object') {
    throw new Error('resolveVersion: packument is required');
  }
  const versionMap = packument.versions ?? {};
  const versions = Object.keys(versionMap);
  const packageName = packument.name ?? 'package';
  if (versions.length === 0) {
    throw new Error(`resolveVersion(${packageName}): packument contains no versions`);
  }
  return {
    packageName,
    versionMap,
    distTags: packument['dist-tags'] ?? {},
    versions,
  };
}

function pickLatest(ctx: ResolveContext): string {
  const latest = ctx.distTags.latest;
  if (latest && ctx.versionMap[latest]) return latest;
  if (latest) {
    throw new Error(
      `resolveVersion(${ctx.packageName}): 'latest' dist-tag points to ${latest} but that version is missing from the packument`
    );
  }
  const best = maxSatisfying(ctx.versions, '*');
  if (best) return best;
  throw new Error(`resolveVersion(${ctx.packageName}): cannot resolve a latest version`);
}

function pickDistTag(ctx: ResolveContext, tag: string): string {
  const tagVersion = ctx.distTags[tag];
  if (tagVersion && ctx.versionMap[tagVersion]) return tagVersion;
  throw new Error(
    `resolveVersion(${ctx.packageName}): dist-tag '${tag}' points to ${tagVersion ?? '(missing)'} which is not in the packument`
  );
}

export function resolveVersion(packument: Packument, range: string): string {
  const ctx = buildResolveContext(packument);
  const requested = (range ?? '').trim();
  // Empty / "latest" -> latest dist-tag. "*" is a valid range and flows into
  // maxSatisfying below so it resolves to the highest stable version, NOT
  // whatever the latest dist-tag happens to point at.
  if (requested === '' || requested === 'latest') {
    return pickLatest(ctx);
  }
  if (ctx.versionMap[requested]) return requested;

  // Valid semver range (including "*", x, X, 1.x) -> resolve via maxSatisfying
  if (isValidRange(requested)) {
    let best: string | null = null;
    try {
      best = maxSatisfying(ctx.versions, requested);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `resolveVersion(${ctx.packageName}): invalid version or range '${requested}' (${reason})`
      );
    }
    if (best) return best;
    const n = ctx.versions.length;
    throw new Error(
      `resolveVersion(${ctx.packageName}): no version satisfies '${requested}' (have ${n} version${n === 1 ? '' : 's'})`
    );
  }

  // Known dist-tag
  if (Object.prototype.hasOwnProperty.call(ctx.distTags, requested)) {
    return pickDistTag(ctx, requested);
  }

  // Unknown dist-tag (looks like a tag name) -> clear error
  if (isLikelyDistTag(requested)) {
    const tags = Object.keys(ctx.distTags).join(', ') || 'none';
    throw new Error(
      `resolveVersion(${ctx.packageName}): unknown dist-tag '${requested}' (available tags: ${tags})`
    );
  }

  // Not a valid range and not a dist-tag
  const n = ctx.versions.length;
  throw new Error(
    `resolveVersion(${ctx.packageName}): invalid version or range '${requested}' (have ${n} version${n === 1 ? '' : 's'})`
  );
}

/**
 * GET a package tarball via the injected `SecureFetch` and return the raw
 * bytes as a `Uint8Array`. Bounded by `opts.timeoutMs` (default 30s);
 * surfaces a clear error on non-2xx, empty body, or timeout.
 */
export async function fetchTarball(
  url: string,
  fetch: SecureFetch,
  opts: RegistryFetchOptions = {}
): Promise<Uint8Array> {
  if (!url || typeof url !== 'string') {
    throw new Error('fetchTarball: url is required');
  }
  const label = `fetchTarball(${url})`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label}: tarball URL is not a valid absolute URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `${label}: refused to fetch tarball with protocol '${parsed.protocol}' (expected 'https:')`
    );
  }
  if (parsed.host !== EXPECTED_TARBALL_HOST) {
    throw new Error(
      `${label}: refused to fetch tarball from host '${parsed.host}' (expected '${EXPECTED_TARBALL_HOST}')`
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let result: FetchResult;
  try {
    result = await withTimeout(
      fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/octet-stream' },
        timeoutMs,
      }),
      timeoutMs,
      label
    );
  } catch (err) {
    if (err instanceof Error && /timed out/.test(err.message)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: network error (${reason})`);
  }

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${label}: ${describeStatus(result, 'registry')}`);
  }

  const bytes = getFetchBodyBytes(result.body);
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`${label}: response body could not be read as bytes`);
  }
  if (bytes.length === 0) {
    throw new Error(`${label}: response body is empty`);
  }
  return bytes;
}
