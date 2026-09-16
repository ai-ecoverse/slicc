#!/usr/bin/env node

/**
 * CLI wrapper for R2 asset bulk uploads.
 * Usage: node upload-assets-to-r2.mjs <bucket> [--dir <dir>] [--concurrency <n>]
 *
 * Example:
 *   node scripts/upload-assets-to-r2.mjs slicc-asset-archive --dir dist/ui/assets
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { runBulkUploads, totalFileBytes } from './upload-lib.mjs';

/** Parse command-line arguments. */
function parseArgs(args) {
  const [bucket, ...rest] = args;
  if (!bucket) {
    throw new Error(
      'Usage: node upload-assets-to-r2.mjs <bucket> [--dir <dir>] [--concurrency <n>]'
    );
  }

  let dir = 'dist/ui/assets';
  // Wrangler's bulk uploader rate-limits itself to 1,100 requests per five
  // minutes. Its default of 20 avoids the old per-object process bottleneck
  // while remaining inside that account-safe window.
  let concurrency = 20;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dir' && i + 1 < rest.length) {
      dir = rest[i + 1];
    } else if (rest[i] === '--concurrency' && i + 1 < rest.length) {
      const n = Number.parseInt(rest[i + 1], 10);
      if (Number.isFinite(n) && n > 0) {
        concurrency = n;
      }
    }
  }

  return { bucket, dir, concurrency };
}

/**
 * Wrap execFile as Promise<void>, resolving the repository-pinned Wrangler
 * through npx and streaming its bulk progress into the CI log.
 */
function createExec() {
  return (argv) =>
    new Promise((resolve, reject) => {
      const proc = execFile('npx', argv, (err) => {
        if (err) reject(err);
        else resolve();
      });

      proc.stdout.pipe(process.stdout);
      proc.stderr.pipe(process.stderr);
    });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

/** Main entry point. */
async function main() {
  try {
    const { bucket, dir, concurrency } = parseArgs(process.argv.slice(2));
    const assetDir = resolve(dir);

    let files;
    try {
      files = await fs.readdir(assetDir);
    } catch (err) {
      console.error(`Failed to read directory ${assetDir}:`, err.message);
      process.exit(1);
    }

    if (files.length === 0) {
      console.warn(`No files found in ${assetDir}`);
      return;
    }

    const totalBytes = await totalFileBytes(files, assetDir);
    const startedAt = Date.now();
    console.log(
      `Bulk-uploading ${files.length} files (${formatBytes(totalBytes)}) to R2 bucket '${bucket}' with concurrency ${concurrency}`
    );

    const result = await runBulkUploads(files, {
      bucket,
      dir: assetDir,
      exec: createExec(),
      concurrency,
      // A failed bulk process retries its idempotent content-type manifest.
      // Every successful re-put intentionally refreshes last-modified for GC.
      retries: 5,
    });

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `R2 bulk upload complete: ${files.length} files in ${result.groups} content-type batches, ${result.invocations} Wrangler invocations (${result.retries} retries), ${elapsedSeconds}s`
    );
  } catch (err) {
    console.error('Upload failed:', err.message);
    process.exit(1);
  }
}

await main();
