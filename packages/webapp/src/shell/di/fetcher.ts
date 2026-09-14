import type { SecureFetch } from 'just-bash';
import { getFetchBodyBytes } from '../fetch-body.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchAndVerifyOptions {
  url: string;

  sha256: string;

  label: string;
  timeoutMs?: number;
}

type DownloadAttempt =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; retriable: boolean; error: Error };

async function attemptDownload(
  fetch: SecureFetch,
  opts: FetchAndVerifyOptions,
  timeoutMs: number
): Promise<DownloadAttempt> {
  let result: Awaited<ReturnType<SecureFetch>>;
  try {
    result = await fetch(opts.url, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream' },
      timeoutMs,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      retriable: true,
      error: new Error(`${opts.label}: network error (${reason})`),
    };
  }

  if (result.status >= 500 && result.status < 600) {
    return {
      ok: false,
      retriable: true,
      error: new Error(`${opts.label}: server error HTTP ${result.status}`),
    };
  }
  if (result.status < 200 || result.status >= 300) {
    const statusText = result.statusText ? ` ${result.statusText}` : '';
    return {
      ok: false,
      retriable: false,
      error: new Error(`${opts.label}: HTTP ${result.status}${statusText}`),
    };
  }

  const bytes = getFetchBodyBytes(result.body);
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return {
      ok: false,
      retriable: false,
      error: new Error(`${opts.label}: response body was empty`),
    };
  }
  return { ok: true, bytes };
}

async function downloadWithRetries(
  fetch: SecureFetch,
  opts: FetchAndVerifyOptions,
  timeoutMs: number
): Promise<Uint8Array> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await attemptDownload(fetch, opts, timeoutMs);
    if (r.ok) return r.bytes;
    lastError = r.error;
    if (!r.retriable || attempt === MAX_ATTEMPTS) throw r.error;
    await delay(RETRY_DELAY_MS * attempt);
  }
  throw lastError ?? new Error(`${opts.label}: download failed`);
}

async function verifyDigest(bytes: Uint8Array, opts: FetchAndVerifyOptions): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual !== opts.sha256.toLowerCase()) {
    throw new Error(
      `${opts.label}: sha256 mismatch (expected ${opts.sha256.toLowerCase()}, got ${actual})`
    );
  }
}

export async function fetchAndVerify(
  fetch: SecureFetch,
  opts: FetchAndVerifyOptions
): Promise<Uint8Array> {
  if (!isHttpsUrl(opts.url)) {
    throw new Error(`${opts.label}: refused to fetch non-https URL '${opts.url}'`);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bytes = await downloadWithRetries(fetch, opts, timeoutMs);
  await verifyDigest(bytes, opts);
  return bytes;
}
