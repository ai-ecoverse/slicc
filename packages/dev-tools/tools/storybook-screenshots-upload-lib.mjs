// Pure upload-orchestration logic for storybook-screenshots-upload.mjs,
// separated so the concurrency and dedup logic is testable without shelling
// out to a real `wrangler` process. The CLI wires an injected `r2` client
// backed by real `wrangler r2 object get/put` subprocess calls; tests inject
// an in-memory fake.

import { join } from 'node:path';

export const DEFAULT_CONCURRENCY = 8;

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

/** Upload every shot in `manifest.shots`, returning the list of newly-uploaded filenames. */
export async function uploadManifest(
  manifest,
  { outDir, prefix, bucket, r2, concurrency = DEFAULT_CONCURRENCY, log = () => {} }
) {
  const shots = manifest.shots || [];
  if (shots.length === 0) {
    log('No screenshots to upload (zero affected stories).');
    return [];
  }
  const results = await mapWithConcurrency(shots, concurrency, (item) =>
    uploadOne(item, { outDir, prefix, bucket, r2, log })
  );
  const newCount = results.filter((r) => r.isNew).length;
  log(`\nSummary: ${newCount} new, ${results.length - newCount} cached (total ${results.length})`);
  return results.filter((r) => r.isNew).map((r) => r.file);
}
