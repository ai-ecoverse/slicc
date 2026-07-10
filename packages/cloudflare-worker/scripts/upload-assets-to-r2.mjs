#!/usr/bin/env node

/**
 * CLI wrapper for R2 asset uploads.
 * Usage: node upload-assets-to-r2.mjs <bucket> [--dir <dir>] [--concurrency <n>]
 *
 * Example:
 *   node scripts/upload-assets-to-r2.mjs slicc-asset-archive --dir dist/ui/assets
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUploads } from './upload-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Parse command-line arguments.
 */
function parseArgs(args) {
  const [bucket, ...rest] = args;
  if (!bucket) {
    throw new Error(
      'Usage: node upload-assets-to-r2.mjs <bucket> [--dir <dir>] [--concurrency <n>]'
    );
  }

  let dir = 'dist/ui/assets'; // default
  let concurrency = 8; // default: parallelize ~300 files fast enough for CI
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
 * Wraps execFile to make it a Promise<void>.
 */
function createExec() {
  // argv is the wrangler command (e.g. ['wrangler','r2','object','put',…]);
  // run it via `npx` so it resolves without node_modules/.bin on PATH (plain
  // CI `run:` steps / publish-worker.sh are not npm scripts).
  return (argv) =>
    new Promise((resolve, reject) => {
      const proc = execFile('npx', argv, (err) => {
        if (err) reject(err);
        else resolve();
      });

      // Inherit stdio so wrangler output is visible
      proc.stdout.pipe(process.stdout);
      proc.stderr.pipe(process.stderr);
    });
}

/**
 * Main entry point.
 */
async function main() {
  try {
    const { bucket, dir, concurrency } = parseArgs(process.argv.slice(2));

    // Resolve the directory (relative to CWD or absolute)
    const assetDir = resolve(dir);

    // List files in the directory
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

    console.log(`Uploading ${files.length} files to R2 bucket '${bucket}'`);

    // Upload with default exec = npx wrangler
    await runUploads(files, {
      bucket,
      dir: assetDir,
      exec: createExec(),
      concurrency, // default 8 — parallelize ~300 files fast enough for CI
      retries: 2,
    });

    console.log('All files uploaded successfully');
  } catch (err) {
    console.error('Upload failed:', err.message);
    process.exit(1);
  }
}

main();
