/**
 * Conda repodata client for `ipk mamba`.
 *
 * Fetches channel `repodata.json` via injected `SecureFetch`, picks the best
 * build for a package name (+ optional version), and builds HTTPS download
 * URLs. HTTPS-only and host-allowlisted — same SecureFetch patterns as npm
 * ipk, pointing at prefix.dev instead of the npm registry.
 *
 * This is intentionally a thin index lookup, not a full SAT solver: virtual
 * packages (`emscripten-abi`, `__*`) are skipped, and hard depends are not
 * auto-installed. Documented in `ipk mamba --help`.
 */

import type { SecureFetch } from 'just-bash';
import { decodeFetchBody, getFetchBodyBytes } from '../fetch-body.js';
import { ALLOWED_CONDA_HOSTS, CONDA_PLATFORM, DEFAULT_CONDA_CHANNELS } from './mamba-prefix.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

export interface CondaPackageRecord {
  name: string;
  version: string;
  build: string;
  build_number?: number;
  depends?: string[];
  subdir?: string;
  md5?: string;
  sha256?: string;
  size?: number;
  timestamp?: number;
  /** Channel base URL this record was resolved from. */
  channel: string;
  /** Filename key in the channel index (`zlib-1.3.1-….tar.bz2`). */
  filename: string;
}

export interface RepodataIndex {
  packages: Record<string, Omit<CondaPackageRecord, 'channel' | 'filename'>>;
  'packages.conda'?: Record<string, Omit<CondaPackageRecord, 'channel' | 'filename'>>;
  info?: { subdir?: string };
  repodata_version?: number;
}

export interface ParsedCondaSpec {
  name: string;
  /** Exact version when the user wrote `name=1.2.3` / `name==1.2.3`; else ''. */
  version: string;
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

function assertAllowedHttpsUrl(url: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label}: URL is not a valid absolute URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label}: refused protocol '${parsed.protocol}' (expected 'https:')`);
  }
  if (!ALLOWED_CONDA_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `${label}: refused host '${parsed.hostname}' (allowed: ${[...ALLOWED_CONDA_HOSTS].join(', ')})`
    );
  }
  return parsed;
}

function describeStatus(result: FetchResult, fallback: string): string {
  const statusText = result.statusText ? ` ${result.statusText}` : '';
  return `${fallback} returned HTTP ${result.status}${statusText}`.trim();
}

/** Parse `zlib`, `zlib=1.3.1`, or `zlib==1.3.1` into name + optional version. */
export function parseCondaSpec(spec: string): ParsedCondaSpec {
  const trimmed = (spec ?? '').trim();
  if (!trimmed) throw new Error('ipk mamba: package spec is required');
  if (trimmed.startsWith('-')) {
    throw new Error(`ipk mamba: invalid package spec '${trimmed}'`);
  }
  const eq = trimmed.indexOf('=');
  if (eq === -1) return { name: trimmed, version: '' };
  const name = trimmed.slice(0, eq);
  let version = trimmed.slice(eq + 1);
  if (version.startsWith('=')) version = version.slice(1);
  if (!name || !version) {
    throw new Error(`ipk mamba: invalid package spec '${trimmed}' (expected name=version)`);
  }
  return { name, version };
}

/** True for virtual / unsatisfiable-from-index depends (skip, do not fetch). */
export function isVirtualCondaDep(dep: string): boolean {
  const name = dep.trim().split(/[\s=<>!]/, 1)[0] ?? '';
  return name.startsWith('__') || name === 'emscripten-abi';
}

function packageUrl(channel: string, subdir: string, filename: string): string {
  const base = channel.replace(/\/+$/, '');
  return `${base}/${subdir}/${filename}`;
}

function repodataUrl(channel: string, subdir: string): string {
  return packageUrl(channel, subdir, 'repodata.json');
}

function compareBuilds(a: CondaPackageRecord, b: CondaPackageRecord): number {
  const an = a.build_number ?? 0;
  const bn = b.build_number ?? 0;
  if (an !== bn) return an - bn;
  const at = a.timestamp ?? 0;
  const bt = b.timestamp ?? 0;
  return at - bt;
}

/**
 * Semver-ish version compare for conda versions (numeric segments first).
 * Good enough for picking "latest" among indexed builds of one name.
 */
export function compareCondaVersions(a: string, b: string): number {
  const as = a.split(/[.+_-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const bs = b.split(/[.+_-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const av = as[i] ?? 0;
    const bv = bs[i] ?? 0;
    if (typeof av === 'number' && typeof bv === 'number') {
      if (av !== bv) return av - bv;
      continue;
    }
    const sa = String(av);
    const sb = String(bv);
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

export async function fetchRepodata(
  channel: string,
  fetch: SecureFetch,
  opts: { subdir?: string; timeoutMs?: number } = {}
): Promise<RepodataIndex> {
  const subdir = opts.subdir ?? CONDA_PLATFORM;
  const url = repodataUrl(channel, subdir);
  const label = `fetchRepodata(${url})`;
  assertAllowedHttpsUrl(url, label);
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
    throw new Error(`${label}: ${reason}`);
  }

  if (result.status < 200 || result.status >= 300) {
    throw new Error(describeStatus(result, label));
  }
  if (result.body == null || (typeof result.body === 'string' && result.body === '')) {
    throw new Error(`${label}: empty body`);
  }

  try {
    return JSON.parse(decodeFetchBody(result.body)) as RepodataIndex;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: invalid JSON (${reason})`);
  }
}

function recordsFromIndex(index: RepodataIndex, channel: string): CondaPackageRecord[] {
  const out: CondaPackageRecord[] = [];
  for (const [bucket, map] of [
    ['packages', index.packages ?? {}],
    ['packages.conda', index['packages.conda'] ?? {}],
  ] as const) {
    void bucket;
    for (const [filename, rec] of Object.entries(map)) {
      out.push({
        ...rec,
        channel,
        filename,
      });
    }
  }
  return out;
}

export interface ResolveCondaPackageOptions {
  fetch: SecureFetch;
  channels?: readonly string[];
  platform?: string;
  /** Also search conda-forge noarch when platform index misses. */
  includeNoarch?: boolean;
  timeoutMs?: number;
  /** Injected index by channel URL (tests). */
  indexes?: Map<string, RepodataIndex>;
}

async function loadChannelIndex(
  channel: string,
  subdir: string,
  opts: ResolveCondaPackageOptions
): Promise<RepodataIndex | null> {
  const cacheKey = `${channel}|${subdir}`;
  const cached = opts.indexes?.get(cacheKey);
  if (cached) return cached;
  try {
    const index = await fetchRepodata(channel, opts.fetch, {
      subdir,
      timeoutMs: opts.timeoutMs,
    });
    opts.indexes?.set(cacheKey, index);
    return index;
  } catch (err) {
    // Missing noarch for a channel that only has platform builds is fine.
    if (subdir === 'noarch') return null;
    throw err;
  }
}

function matchingRecords(
  index: RepodataIndex,
  channel: string,
  subdir: string,
  parsed: ParsedCondaSpec
): CondaPackageRecord[] {
  const out: CondaPackageRecord[] = [];
  for (const rec of recordsFromIndex(index, channel)) {
    if (rec.name !== parsed.name) continue;
    if (parsed.version && rec.version !== parsed.version) continue;
    out.push({ ...rec, subdir: rec.subdir ?? subdir });
  }
  return out;
}

function pickNewest(candidates: CondaPackageRecord[]): CondaPackageRecord {
  candidates.sort((a, b) => {
    const v = compareCondaVersions(a.version, b.version);
    if (v !== 0) return v;
    return compareBuilds(a, b);
  });
  return candidates[candidates.length - 1]!;
}

/**
 * Find the newest matching package across channels. Prefers earlier channels
 * when versions tie; within a channel prefers higher build_number / timestamp.
 */
export async function resolveCondaPackage(
  spec: string | ParsedCondaSpec,
  opts: ResolveCondaPackageOptions
): Promise<CondaPackageRecord> {
  const parsed = typeof spec === 'string' ? parseCondaSpec(spec) : spec;
  const channels = opts.channels ?? DEFAULT_CONDA_CHANNELS;
  const platform = opts.platform ?? CONDA_PLATFORM;
  const subdirs = (opts.includeNoarch ?? true) ? [platform, 'noarch'] : [platform];

  const candidates: CondaPackageRecord[] = [];
  for (const channel of channels) {
    for (const subdir of subdirs) {
      const index = await loadChannelIndex(channel, subdir, opts);
      if (!index) continue;
      candidates.push(...matchingRecords(index, channel, subdir, parsed));
    }
  }

  if (candidates.length === 0) {
    const want = parsed.version ? `${parsed.name}=${parsed.version}` : parsed.name;
    throw new Error(
      `ipk mamba: package '${want}' not found on ${channels.join(', ')} ` + `(platform ${platform})`
    );
  }

  return pickNewest(candidates);
}

export function condaPackageDownloadUrl(record: CondaPackageRecord): string {
  const subdir = record.subdir ?? CONDA_PLATFORM;
  return packageUrl(record.channel, subdir, record.filename);
}

export async function downloadCondaPackage(
  record: CondaPackageRecord,
  fetch: SecureFetch,
  opts: { timeoutMs?: number } = {}
): Promise<Uint8Array> {
  const url = condaPackageDownloadUrl(record);
  const label = `downloadCondaPackage(${url})`;
  assertAllowedHttpsUrl(url, label);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

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
    throw new Error(`${label}: ${reason}`);
  }

  if (result.status < 200 || result.status >= 300) {
    throw new Error(describeStatus(result, label));
  }
  if (result.body == null || (typeof result.body === 'string' && result.body === '')) {
    throw new Error(`${label}: empty body`);
  }
  const bytes = getFetchBodyBytes(result.body);
  if (bytes.length === 0) {
    throw new Error(`${label}: empty body`);
  }
  return bytes;
}
