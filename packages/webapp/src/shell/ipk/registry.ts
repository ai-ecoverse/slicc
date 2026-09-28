/**
 * npm registry client for ipk (Ice Pack).
 *
 * Pure, dependency-light, individually unit-testable. Takes an injected
 * `SecureFetch` so it works in the worker realm across all floats
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
import {
  exactVersion,
  isValidRange,
  maxOnReleaseLine,
  maxSatisfying,
  satisfies,
} from './semver.js';

export const REGISTRY_NPMJS_HOST = REGISTRY_HOST_INTERNAL;
export const EXPECTED_TARBALL_HOST = REGISTRY_HOST_INTERNAL;
export const registryUrl = buildRegistryUrl;
export { validateNpmPackageName };

const DEFAULT_TIMEOUT_MS = 30_000;
/** Large packages (e.g. `@ffmpeg/core` ~20 MB) need more than the packument budget. */
const DEFAULT_TARBALL_TIMEOUT_MS = 120_000;

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
  /** Deprecation message; an empty string does not deprecate (npm's rule). */
  deprecated?: string;
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

export interface PackumentFetchOptions extends RegistryFetchOptions {
  /** Ask for the full packument instead of npm's abbreviated install metadata. */
  full?: boolean;
}

/**
 * npm's abbreviated ("corgi") install metadata, preferred as pnpm asks for it.
 * It keeps what an installer reads (`dist-tags`, and per version `dist`,
 * `deprecated`, the dependency sections, `bin`, `engines`, `os`, `cpu`) and
 * drops READMEs, maintainers and the like (the typescript packument: 8.7 MB
 * instead of 15.7 MB). Empty sections such as `dependencies: {}` are
 * omitted, which ipk reads the same as absent ones.
 */
const ABBREVIATED_ACCEPT =
  'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';
const FULL_ACCEPT = 'application/json';

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
 * and return the parsed packument. Asks for npm's abbreviated install
 * metadata first and falls back to the full packument when the response
 * lacks something ipk installs from (see {@link hasInstallMetadata}), or
 * straight away with `opts.full`. Each request is bounded by
 * `opts.timeoutMs` (default 30s); surfaces a clear error on non-2xx,
 * malformed JSON, empty response, or timeout.
 */
export async function fetchPackument(
  name: string,
  fetch: SecureFetch,
  opts: PackumentFetchOptions = {}
): Promise<Packument> {
  if (!name || typeof name !== 'string') {
    throw new Error('fetchPackument: package name is required');
  }
  if (!opts.full) {
    const abbreviated = await requestPackument(name, fetch, opts, ABBREVIATED_ACCEPT);
    if (hasInstallMetadata(abbreviated)) return abbreviated;
  }
  return requestPackument(name, fetch, opts, FULL_ACCEPT);
}

/**
 * True when `packument` carries everything ipk installs from: a `dist-tags`
 * object and, for every version, `dist.tarball` plus a hash to verify it
 * against (`dist.integrity` or `dist.shasum`). The other fields ipk reads
 * (`deprecated`, `dependencies`, `bin`) are optional in both formats, so
 * their absence cannot be told from "not set"; npm's abbreviated format
 * keeps each of them whenever the full packument has it.
 */
function hasInstallMetadata(packument: Packument): boolean {
  const tags = packument['dist-tags'];
  if (!tags || typeof tags !== 'object') return false;
  for (const entry of Object.values(packument.versions)) {
    const dist = entry?.dist;
    if (!dist || typeof dist.tarball !== 'string') return false;
    if (typeof dist.integrity !== 'string' && typeof dist.shasum !== 'string') return false;
  }
  return true;
}

async function requestPackument(
  name: string,
  fetch: SecureFetch,
  opts: RegistryFetchOptions,
  accept: string
): Promise<Packument> {
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
        headers: { Accept: accept },
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
 * Picking a version for `name@range` follows pnpm's picker
 * (`pick_package_from_meta` in pnpm 12, the same rules as pnpm 11 and
 * npm-pick-manifest). `pnpm-picker-oracle.test.ts` checks it against pnpm:
 *   1. Empty / "latest" → the `latest` dist-tag.
 *   2. An exact version (build metadata ignored) → that version, even when
 *      it is deprecated.
 *   3. A semver range, where "x" means "*":
 *      - when `latest` satisfies it (for "*", whatever `latest` is), `latest`;
 *      - otherwise the highest satisfying version;
 *      - either way a deprecated pick gives way to the highest live version
 *        the range admits, and for "*" with a prerelease `latest`, to the
 *        highest live version of `latest`'s release line. When nothing live
 *        satisfies, the deprecated pick stands.
 *   4. A dist-tag → the version it points at.
 *
 * A version counts as deprecated when its `deprecated` message is non-empty,
 * as npm and pnpm 11 have it. pnpm 12 also counts `deprecated: ""`; ipk does
 * not.
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

function pickDistTag(ctx: ResolveContext, tag: string): string {
  const tagVersion = ctx.distTags[tag];
  if (tagVersion && ctx.versionMap[tagVersion]) return tagVersion;
  throw new Error(
    `resolveVersion(${ctx.packageName}): dist-tag '${tag}' points to ${tagVersion ?? '(missing)'} which is not in the packument`
  );
}

/** npm's and pnpm 11's rule: an empty deprecation message is not a deprecation. */
function isDeprecated(ctx: ResolveContext, version: string): boolean {
  return Boolean(ctx.versionMap[version]?.deprecated);
}

/**
 * pnpm's `non_deprecated_pick`: when `picked` is deprecated, the version to
 * take instead, or null to keep `picked`.
 */
function nonDeprecatedPick(ctx: ResolveContext, picked: string, range: string): string | null {
  if (!isDeprecated(ctx, picked) || ctx.versions.length <= 1) return null;
  const live = ctx.versions.filter((v) => !isDeprecated(ctx, v));
  if (range === '*' && !satisfies(picked, '*')) {
    // A deprecated prerelease `latest`: stay on its release line.
    const sameLine = maxOnReleaseLine(live, picked);
    if (sameLine) return sameLine;
  }
  return maxSatisfying(live, range);
}

/** pnpm's `pick_version_by_version_range`, without lockfile-preferred versions. */
function pickFromRange(ctx: ResolveContext, range: string): string | null {
  const latest = ctx.distTags.latest;
  if (latest && (range === '*' || satisfies(latest, range))) {
    return nonDeprecatedPick(ctx, latest, range) ?? latest;
  }
  const best = maxSatisfying(ctx.versions, range);
  if (!best) return null;
  return nonDeprecatedPick(ctx, best, range) ?? best;
}

function noVersionError(ctx: ResolveContext, requested: string): Error {
  const n = ctx.versions.length;
  return new Error(
    `resolveVersion(${ctx.packageName}): no version satisfies '${requested}' (have ${n} version${n === 1 ? '' : 's'})`
  );
}

export function resolveVersion(packument: Packument, range: string): string {
  const ctx = buildResolveContext(packument);
  const requested = (range ?? '').trim();
  if (requested === '' || requested === 'latest') {
    if (ctx.distTags.latest === undefined) {
      throw new Error(`resolveVersion(${ctx.packageName}): packument has no 'latest' dist-tag`);
    }
    return pickDistTag(ctx, 'latest');
  }

  const exact = exactVersion(requested);
  if (exact !== null) {
    if (ctx.versionMap[exact]) return exact;
    throw noVersionError(ctx, requested);
  }

  if (isValidRange(requested)) {
    const picked = pickFromRange(ctx, requested === 'x' ? '*' : requested);
    if (picked === null) throw noVersionError(ctx, requested);
    if (!ctx.versionMap[picked]) {
      throw new Error(
        `resolveVersion(${ctx.packageName}): 'latest' dist-tag points to ${picked} but that version is missing from the packument`
      );
    }
    return picked;
  }

  if (Object.prototype.hasOwnProperty.call(ctx.distTags, requested)) {
    return pickDistTag(ctx, requested);
  }

  if (isLikelyDistTag(requested)) {
    const tags = Object.keys(ctx.distTags).join(', ') || 'none';
    throw new Error(
      `resolveVersion(${ctx.packageName}): unknown dist-tag '${requested}' (available tags: ${tags})`
    );
  }

  const n = ctx.versions.length;
  throw new Error(
    `resolveVersion(${ctx.packageName}): invalid version or range '${requested}' (have ${n} version${n === 1 ? '' : 's'})`
  );
}

/**
 * GET a package tarball via the injected `SecureFetch` and return the raw
 * bytes as a `Uint8Array`. Bounded by `opts.timeoutMs` (default 120s —
 * wasm cores and similar artifacts are multi-megabyte); surfaces a clear
 * error on non-2xx, empty body, or timeout.
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TARBALL_TIMEOUT_MS;

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
