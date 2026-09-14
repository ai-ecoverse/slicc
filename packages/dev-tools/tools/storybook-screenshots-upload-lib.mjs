import { join } from 'node:path';

export const DEFAULT_CONCURRENCY = 4;

export const DEFAULT_RETRIES = 5;

export const RETRY_BASE_DELAY_MS = 500;

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function retryDelayMs(attempt, random = Math.random) {
  return Math.round(random() * RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
}

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
