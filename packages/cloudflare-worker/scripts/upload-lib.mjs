/**
 * R2 bulk-upload helpers, testable with an injectable exec function.
 * Imports from ../src/asset-archive.mjs for the single shared predicate + MIME map.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * Group manifest entries by content type. Wrangler's bulk command applies one
 * content type to the whole manifest, so separate groups preserve the exact
 * metadata that the old per-object uploader set.
 */
export function buildManifestGroups(files, dir) {
  assertAllHashed(files);

  const byContentType = new Map();
  for (const file of files) {
    const contentType = mimeForAssetPath(`/assets/${file}`);
    const entries = byContentType.get(contentType) ?? [];
    entries.push({
      key: `assets/${file}`,
      file: dir ? join(dir, file) : file,
    });
    byContentType.set(contentType, entries);
  }

  // Upload the largest group first so the dominant work begins immediately.
  // The content-type tie-break keeps manifests deterministic for diagnostics.
  return [...byContentType.entries()]
    .map(([contentType, entries]) => ({ contentType, entries }))
    .sort(
      (left, right) =>
        right.entries.length - left.entries.length ||
        left.contentType.localeCompare(right.contentType)
    );
}

/**
 * Build one `wrangler r2 bulk put` argv. `--remote` is mandatory because
 * Wrangler otherwise defaults to local Miniflare storage; `--force` avoids an
 * interactive data-catalog prompt in CI.
 */
export function buildBulkPutArgs(bucket, manifestPath, contentType, concurrency) {
  return [
    'wrangler',
    'r2',
    'bulk',
    'put',
    bucket,
    '--filename',
    manifestPath,
    '--content-type',
    contentType,
    '--concurrency',
    String(concurrency),
    '--remote',
    '--force',
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
 * jitter so concurrent account activity does not retry in lockstep.
 */
export function retryDelayMs(attempt, random = Math.random) {
  return Math.round(random() * RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
}

/**
 * Upload all files through one Wrangler process per content type. Groups run
 * sequentially so the requested R2 concurrency is the account pressure, not
 * that value multiplied by the number of MIME types.
 */
export async function runBulkUploads(
  files,
  { bucket, dir, exec, concurrency = 20, retries = 1, sleep = defaultSleep }
) {
  // Validate the complete set before creating manifests or uploading anything.
  const groups = buildManifestGroups(files, dir);
  if (groups.length === 0) {
    return { groups: 0, invocations: 0, retries: 0 };
  }

  const manifestDir = await fs.mkdtemp(join(tmpdir(), 'slicc-r2-bulk-'));
  try {
    // Materialize every manifest before the first remote mutation. A local I/O
    // failure therefore cannot leave an avoidably partial archive refresh.
    const manifests = [];
    for (const [index, group] of groups.entries()) {
      const manifestPath = join(manifestDir, `manifest-${index + 1}.json`);
      await fs.writeFile(manifestPath, `${JSON.stringify(group.entries)}\n`, 'utf8');
      manifests.push({ ...group, manifestPath });
    }

    let invocations = 0;
    let retryCount = 0;
    for (const manifest of manifests) {
      const attempts = await uploadManifestWithRetry({
        bucket,
        manifest,
        exec,
        concurrency,
        retries,
        sleep,
      });
      invocations += attempts;
      retryCount += attempts - 1;
    }

    return { groups: groups.length, invocations, retries: retryCount };
  } finally {
    await fs.rm(manifestDir, { recursive: true, force: true });
  }
}

async function uploadManifestWithRetry({ bucket, manifest, exec, concurrency, retries, sleep }) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await exec(
        buildBulkPutArgs(
          bucket,
          manifest.manifestPath,
          manifest.contentType,
          Math.max(concurrency, 1)
        )
      );
      return attempt;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(retryDelayMs(attempt));
      }
    }
  }

  throw lastError;
}
