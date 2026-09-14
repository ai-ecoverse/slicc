import { matchHashedAssetPath, mimeForAssetPath } from '../src/asset-archive.mjs';

export function assertAllHashed(names) {
  for (const name of names) {
    if (!matchHashedAssetPath(`/assets/${name}`)) {
      throw new Error(`Asset not hashed: ${name}`);
    }
  }
}

export function buildPutArgs(bucket, file, dir) {
  const objectPath = `${bucket}/assets/${file}`;
  const mime = mimeForAssetPath(`/assets/${file}`);

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

export const RETRY_BASE_DELAY_MS = 500;

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function retryDelayMs(attempt, random = Math.random) {
  return Math.round(random() * RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
}

export async function runUploads(
  files,
  { bucket, dir, exec, concurrency = 1, retries = 1, sleep = defaultSleep }
) {
  assertAllHashed(files);

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

async function uploadWithRetry(file, bucket, dir, exec, retries, sleep) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const argv = buildPutArgs(bucket, file, dir);
      await exec(argv);
      return;
    } catch (err) {
      lastError = err;

      if (attempt < retries) {
        await sleep(retryDelayMs(attempt));
      }
    }
  }

  throw lastError;
}
