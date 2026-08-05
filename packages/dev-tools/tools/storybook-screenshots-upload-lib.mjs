// Pure upload-orchestration logic for storybook-screenshots-upload.mjs,
// separated so the concurrency and dedup logic is testable without shelling
// out to a real `wrangler` process. The CLI wires an injected `r2` client
// backed by real `wrangler r2 object get/put` subprocess calls; tests inject
// an in-memory fake.

import { join } from 'node:path';

// 4, not 8: the worker's R2 asset upload hit `429` / code 971 ("Please wait and
// consider throttling your request speed") at concurrency 8, and this uploader
// targets the same account-wide R2 limit.
export const DEFAULT_CONCURRENCY = 4;

/** Max attempts per shot before the upload is treated as failed. */
export const DEFAULT_RETRIES = 5;

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

/** Run `fn` over `items` with at most `limit` in flight at once. */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Upload one manifest shot, content-hash deduplicated: if `hashes/<hash>`
 * already exists in the bucket, write only a small `.ref` pointer at the
 * PR-scoped key; otherwise upload the PNG at both the PR-scoped key and the
 * hash-scoped key (so future PRs with identical content can dedupe against it).
 *
 * `r2` is `{ exists(bucket, key), putFile(bucket, key, filePath, contentType),
 * putText(bucket, key, text, contentType) }`.
 */
export async function uploadOne(item, { outDir, prefix, bucket, r2, log }) {
  const src = join(outDir, item.file);
  const key = `${prefix}/${item.file}`;
  const hashKey = `hashes/${item.contentHash}`;

  const cached = await r2.exists(bucket, hashKey);
  if (cached) {
    await r2.putText(bucket, `${key}.ref`, item.contentHash, 'text/plain');
    log(`  ⊙ ${item.file} (cached, hash ${item.contentHash.slice(0, 8)}…)`);
    return { file: item.file, isNew: false };
  }

  await r2.putFile(bucket, key, src, 'image/png');
  await r2.putFile(bucket, hashKey, src, 'image/png');
  log(`  ↑ ${item.file} -> r2://${bucket}/${key} (new, hash ${item.contentHash.slice(0, 8)}…)`);
  return { file: item.file, isNew: true };
}

/**
 * `uploadOne` with retries. Without a delay a retry re-fires instantly into the
 * same R2 rate-limit window (429 / code 971) and burns every remaining attempt
 * in milliseconds. Retrying the whole shot is safe: both the existence check
 * and the puts are idempotent.
 */
export async function uploadOneWithRetry(
  item,
  { outDir, prefix, bucket, r2, log, retries = DEFAULT_RETRIES, sleep = defaultSleep }
) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await uploadOne(item, { outDir, prefix, bucket, r2, log });
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(retryDelayMs(attempt));
      }
    }
  }
  throw lastError;
}

/** Upload every shot in `manifest.shots`, returning the list of newly-uploaded filenames. */
export async function uploadManifest(
  manifest,
  {
    outDir,
    prefix,
    bucket,
    r2,
    concurrency = DEFAULT_CONCURRENCY,
    retries = DEFAULT_RETRIES,
    sleep = defaultSleep,
    log = () => {},
  }
) {
  const shots = manifest.shots || [];
  if (shots.length === 0) {
    log('No screenshots to upload (zero affected stories).');
    return [];
  }
  const results = await mapWithConcurrency(shots, concurrency, (item) =>
    uploadOneWithRetry(item, { outDir, prefix, bucket, r2, log, retries, sleep })
  );
  const newCount = results.filter((r) => r.isNew).length;
  log(`\nSummary: ${newCount} new, ${results.length - newCount} cached (total ${results.length})`);
  return results.filter((r) => r.isNew).map((r) => r.file);
}
