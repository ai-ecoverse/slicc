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

/**
 * Best-effort total used only for progress logging. A file can disappear
 * between readdir and stat; leave authoritative validation to Wrangler so a
 * cosmetic byte count cannot prevent the upload from starting.
 */
export async function totalFileBytes(files, dir, stat = fs.stat) {
  const sizes = await Promise.all(
    files.map(async (file) => {
      try {
        return (await stat(join(dir, file))).size;
      } catch {
        return 0;
      }
    })
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

/**
 * Most objects one Wrangler invocation puts. `wrangler r2 bulk put` aborts the
 * whole manifest on the first failed object and reports nothing about the
 * ones that succeeded, so a 429 on a 684-object manifest re-sent all 684 on
 * every retry — burning the account's request budget faster than a backoff
 * could restore it. A failed chunk re-sends at most this many.
 */
export const MANIFEST_CHUNK_SIZE = 100;

/** Base delay for the exponential retry backoff, in milliseconds. */
export const RETRY_BASE_DELAY_MS = 2_000;

/**
 * Longest single backoff. R2's API budget is counted per five minutes
 * (Wrangler caps itself at 1,100 requests per window, account-wide), so the
 * retry schedule has to be able to wait a real fraction of that window out.
 */
export const RETRY_MAX_DELAY_MS = 60_000;

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Delay before retry `attempt`: exponential (2s, 4s, 8s, … capped at 60s)
 * with equal jitter — half the step is always waited, so a rate-limited
 * upload cannot retry immediately, and the other half is random so
 * concurrent account activity does not retry in lockstep.
 */
export function retryDelayMs(attempt, random = Math.random) {
  const step = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(step / 2 + random() * (step / 2));
}

/**
 * Concurrency for retry `attempt`: halved on every retry, never below 1. A
 * 429 means the account is over budget; hitting it with the same fan-out
 * again only spends the recovering budget faster.
 */
export function retryConcurrency(concurrency, attempt) {
  return Math.max(1, Math.floor(Math.max(concurrency, 1) / 2 ** (attempt - 1)));
}

/** Split `entries` into manifests of at most `size` objects, in order. */
export function chunkEntries(entries, size = MANIFEST_CHUNK_SIZE) {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks = [];
  for (let i = 0; i < entries.length; i += chunkSize) {
    chunks.push(entries.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Upload all files through Wrangler, one bounded manifest at a time. Each
 * content type is split into {@link MANIFEST_CHUNK_SIZE} chunks and chunks run
 * sequentially, so the requested R2 concurrency is the account pressure, and
 * a failure retries only the chunk that failed — the chunks already written
 * are never re-sent.
 */
export async function runBulkUploads(
  files,
  {
    bucket,
    dir,
    exec,
    concurrency = 20,
    retries = 1,
    chunkSize = MANIFEST_CHUNK_SIZE,
    sleep = defaultSleep,
    random = Math.random,
    log = () => {},
  }
) {
  // Validate the complete set before creating manifests or uploading anything.
  const groups = buildManifestGroups(files, dir);
  if (groups.length === 0) {
    return { groups: 0, chunks: 0, invocations: 0, retries: 0 };
  }

  const manifestDir = await fs.mkdtemp(join(tmpdir(), 'slicc-r2-bulk-'));
  try {
    // Materialize every manifest before the first remote mutation. A local I/O
    // failure therefore cannot leave an avoidably partial archive refresh.
    const manifests = [];
    for (const group of groups) {
      for (const entries of chunkEntries(group.entries, chunkSize)) {
        const manifestPath = join(manifestDir, `manifest-${manifests.length + 1}.json`);
        await fs.writeFile(manifestPath, `${JSON.stringify(entries)}\n`, 'utf8');
        manifests.push({ contentType: group.contentType, entries, manifestPath });
      }
    }

    let invocations = 0;
    let retryCount = 0;
    for (const [index, manifest] of manifests.entries()) {
      const attempts = await uploadManifestWithRetry({
        bucket,
        manifest,
        exec,
        concurrency,
        retries,
        sleep,
        random,
        log: (message) => log(`chunk ${index + 1}/${manifests.length}: ${message}`),
      });
      invocations += attempts;
      retryCount += attempts - 1;
    }

    return {
      groups: groups.length,
      chunks: manifests.length,
      invocations,
      retries: retryCount,
    };
  } finally {
    await fs.rm(manifestDir, { recursive: true, force: true });
  }
}

async function uploadManifestWithRetry({
  bucket,
  manifest,
  exec,
  concurrency,
  retries,
  sleep,
  random,
  log,
}) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await exec(
        buildBulkPutArgs(
          bucket,
          manifest.manifestPath,
          manifest.contentType,
          retryConcurrency(concurrency, attempt)
        )
      );
      return attempt;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const delay = retryDelayMs(attempt, random);
        log(
          `attempt ${attempt}/${retries} failed (${errorSummary(err)}); ` +
            `retrying ${manifest.entries.length} objects in ${(delay / 1000).toFixed(1)}s ` +
            `with concurrency ${retryConcurrency(concurrency, attempt + 1)}`
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

function errorSummary(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0].slice(0, 160);
}
