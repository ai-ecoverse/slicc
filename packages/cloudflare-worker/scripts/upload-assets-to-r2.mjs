#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUploads } from './upload-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function parseArgs(args) {
  const [bucket, ...rest] = args;
  if (!bucket) {
    throw new Error(
      'Usage: node upload-assets-to-r2.mjs <bucket> [--dir <dir>] [--concurrency <n>]'
    );
  }

  let dir = 'dist/ui/assets';

  let concurrency = 4;
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

    console.log(`Uploading ${files.length} files to R2 bucket '${bucket}'`);

    await runUploads(files, {
      bucket,
      dir: assetDir,
      exec: createExec(),
      concurrency,

      retries: 5,
    });

    console.log('All files uploaded successfully');
  } catch (err) {
    console.error('Upload failed:', err.message);
    process.exit(1);
  }
}

await main();
