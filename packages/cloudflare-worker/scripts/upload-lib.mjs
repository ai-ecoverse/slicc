/**
 * Pure helpers for R2 asset upload, testable with injectable exec.
 * Imports from ../src/asset-archive.mjs for the single shared predicate + MIME map.
 */

import { matchHashedAssetPath, mimeForAssetPath } from '../src/asset-archive.mjs';

/**
 * Throws if any filename lacks a content hash (fails the invariant).
 */
export function assertAllHashed(names) {
  for (const name of names) {
    if (!matchHashedAssetPath(`/assets/${name}`)) {
      throw new Error(`Asset not hashed: ${name}`);
    }
  }
}

/**
 * Build the wrangler r2 object put argv for a single file.
 * @param {string} bucket - R2 bucket name (e.g., "slicc-asset-archive")
 * @param {string} file - filename (e.g., "index-abc123.css")
 * @returns {string[]} argv to pass to execFile('npx', [...])
 */
export function buildPutArgs(bucket, file, dir) {
  const objectPath = `${bucket}/assets/${file}`;
  const mime = mimeForAssetPath(`/assets/${file}`);
  // --file must resolve from the exec's cwd; the caller passes the (absolute)
  // asset dir. --remote is REQUIRED: `wrangler r2 object put` defaults to LOCAL
  // (miniflare) storage, which would silently never populate the real bucket.
  const filePath = dir ? `${dir}/${file}` : file;

  return [
    'wrangler',
    'r2',
    'object',
    'put',
    objectPath,
    '--file',
    filePath,
    '--content-type',
    mime,
    '--remote',
  ];
}

/** Base delay for the exponential retry backoff, in milliseconds. */
export const RETRY_BASE_DELAY_MS = 500;

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Delay before retry `attempt`: exponential (500ms, 1s, 2s, 4s, …) with full
 * jitter so a batch that trips the R2 rate limit together doesn't retry in
 * lockstep and trip it again.
 */
export function retryDelayMs(attempt, random = Math.random) {
  return Math.round(random() * RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
}

/**
 * Run uploads with bounded concurrency and per-file retries.
 * @param {string[]} files - filenames (already validated by assertAllHashed)
 * @param {object} opts
 * @param {string} opts.bucket - R2 bucket name
 * @param {string} opts.dir - working directory for file resolution
 * @param {Function} opts.exec - injectable exec function: (argv) => Promise<void>
 * @param {number} [opts.concurrency=1] - max concurrent uploads
 * @param {number} [opts.retries=1] - max attempts per file
 * @param {Function} [opts.sleep] - injectable delay: (ms) => Promise<void>
 * @returns {Promise<void>}
 */
export async function runUploads(
  files,
  { bucket, dir, exec, concurrency = 1, retries = 1, sleep = defaultSleep }
) {
  // Validate hash invariant before any upload attempt
  assertAllHashed(files);

  // Rolling workers rather than fixed batches: a batch barrier would leave the
  // other slots idle for the whole backoff of a single retrying file.
  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      await uploadWithRetry(file, bucket, dir, exec, retries, sleep);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(concurrency, 1), files.length) }, worker)
  );
}

/**
 * Upload a single file with retries.
 */
async function uploadWithRetry(file, bucket, dir, exec, retries, sleep) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const argv = buildPutArgs(bucket, file, dir);
      await exec(argv);
      return; // success
    } catch (err) {
      lastError = err;
      // Back off before retrying. Without this, a retry re-fires instantly
      // into the same R2 rate-limit window (429 / code 971) and burns every
      // remaining attempt in milliseconds.
      if (attempt < retries) {
        await sleep(retryDelayMs(attempt));
      }
    }
  }

  throw lastError;
}
