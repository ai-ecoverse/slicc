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
export function buildPutArgs(bucket, file) {
  const objectPath = `${bucket}/assets/${file}`;
  const mime = mimeForAssetPath(`/assets/${file}`);

  return ['wrangler', 'r2', 'object', 'put', objectPath, '--file', file, '--content-type', mime];
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
 * @returns {Promise<void>}
 */
export async function runUploads(files, { bucket, dir, exec, concurrency = 1, retries = 1 }) {
  // Validate hash invariant before any upload attempt
  assertAllHashed(files);

  // Split into batches to respect concurrency
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const promises = batch.map((file) => uploadWithRetry(file, bucket, exec, retries));

    await Promise.all(promises);
  }
}

/**
 * Upload a single file with retries.
 */
async function uploadWithRetry(file, bucket, exec, retries) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const argv = buildPutArgs(bucket, file);
      await exec(argv);
      return; // success
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
      }
    }
  }

  throw lastError;
}
