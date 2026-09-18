import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchHashedAssetPath, mimeForAssetPath } from '../src/asset-archive.mjs';

export function assertAllHashed(names) {
  for (const name of names) {
    if (!matchHashedAssetPath(`/assets/${name}`)) {
      throw new Error(`Asset not hashed: ${name}`);
    }
  }
}

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

  return [...byContentType.entries()]
    .map(([contentType, entries]) => ({ contentType, entries }))
    .sort(
      (left, right) =>
        right.entries.length - left.entries.length ||
        left.contentType.localeCompare(right.contentType)
    );
}

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

export const MANIFEST_CHUNK_SIZE = 100;

export const RETRY_BASE_DELAY_MS = 2_000;

export const RETRY_MAX_DELAY_MS = 60_000;

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function retryDelayMs(attempt, random = Math.random) {
  const step = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(step / 2 + random() * (step / 2));
}

export function retryConcurrency(concurrency, attempt) {
  return Math.max(1, Math.floor(Math.max(concurrency, 1) / 2 ** (attempt - 1)));
}

export function chunkEntries(entries, size = MANIFEST_CHUNK_SIZE) {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks = [];
  for (let i = 0; i < entries.length; i += chunkSize) {
    chunks.push(entries.slice(i, i + chunkSize));
  }
  return chunks;
}

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
  const groups = buildManifestGroups(files, dir);
  if (groups.length === 0) {
    return { groups: 0, chunks: 0, invocations: 0, retries: 0 };
  }

  const manifestDir = await fs.mkdtemp(join(tmpdir(), 'slicc-r2-bulk-'));
  try {
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
