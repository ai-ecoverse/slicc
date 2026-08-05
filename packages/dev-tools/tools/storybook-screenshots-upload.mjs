#!/usr/bin/env node
// Uploads the manifest.json produced by storybook-affected-screenshots.mjs to
// a Cloudflare R2 bucket, content-hash deduplicated, with bounded concurrency.
// Pure orchestration logic lives in storybook-screenshots-upload-lib.mjs; this
// file only wires a real `wrangler r2 object get/put` client and CLI args.
//
// Sequential per-file `wrangler` subprocess spawns (the previous inline
// workflow script) took ~4s/file (existence check + put, sometimes a second
// put for the hash blob) — over an hour for a few hundred affected stories.
// Running N uploads concurrently cuts wall-clock roughly by the concurrency
// factor; R2/wrangler has no documented per-account rate limit that a modest
// concurrency would trip.
//
// Usage:
//   node packages/dev-tools/tools/storybook-screenshots-upload.mjs \
//     --manifest=<dir>/manifest.json --out-dir=<dir> --prefix=pr-123/<sha> \
//     --bucket=slicc-pr-screenshots --new-uploads-out=<path> [--concurrency=8]
//
// Requires CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID) in the environment
// for `npx wrangler r2 object` to authenticate. Exit codes: 0 = success
// (including "nothing to upload"); 2 = bad CLI usage; non-zero on any upload
// failure.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { DEFAULT_CONCURRENCY, uploadManifest } from './storybook-screenshots-upload-lib.mjs';

const execFileAsync = promisify(execFile);

/** Real `wrangler r2 object` client, backing the injectable `r2` interface. */
const wranglerR2 = {
  /** `true` if `bucket/key` exists (wrangler exits non-zero when absent). */
  async exists(bucket, key) {
    try {
      await execFileAsync('npx', [
        'wrangler',
        'r2',
        'object',
        'get',
        `${bucket}/${key}`,
        '--remote',
      ]);
      return true;
    } catch {
      return false;
    }
  },
  async putFile(bucket, key, filePath, contentType) {
    await execFileAsync('npx', [
      'wrangler',
      'r2',
      'object',
      'put',
      `${bucket}/${key}`,
      '--file',
      filePath,
      '--content-type',
      contentType,
      '--remote',
    ]);
  },
  async putText(bucket, key, text, contentType) {
    // wrangler has no "put from stdin string" flag exposed via execFile args
    // (the original inline script piped through a shell `echo`); write a
    // small temp file instead, since execFile takes no shell pipe.
    const tmpDir = mkdtempSync(join(tmpdir(), 'sb-upload-'));
    const tmpFile = join(tmpDir, 'ref.txt');
    writeFileSync(tmpFile, text);
    try {
      await this.putFile(bucket, key, tmpFile, contentType);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
};

async function main() {
  const { values: args } = parseArgs({
    options: {
      manifest: { type: 'string' },
      'out-dir': { type: 'string' },
      prefix: { type: 'string' },
      bucket: { type: 'string' },
      'new-uploads-out': { type: 'string' },
      concurrency: { type: 'string', default: String(DEFAULT_CONCURRENCY) },
    },
  });
  const { manifest: manifestPath, prefix, bucket } = args;
  const outDir = args['out-dir'];
  const newUploadsOut = args['new-uploads-out'];
  if (!manifestPath || !outDir || !prefix || !bucket || !newUploadsOut) {
    stderr.write(
      'usage: storybook-screenshots-upload.mjs --manifest=<path> --out-dir=<dir> ' +
        '--prefix=<pr-N/sha> --bucket=<name> --new-uploads-out=<path> [--concurrency=8]\n'
    );
    exit(2);
  }
  if (!existsSync(manifestPath)) {
    stdout.write(`No manifest at ${manifestPath}; nothing to upload.\n`);
    writeFileSync(newUploadsOut, '[]');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const concurrency = Math.max(1, Number.parseInt(args.concurrency, 10) || DEFAULT_CONCURRENCY);
  const newUploads = await uploadManifest(manifest, {
    outDir,
    prefix,
    bucket,
    r2: wranglerR2,
    concurrency,
    log: (msg) => stdout.write(`${msg}\n`),
  });
  writeFileSync(newUploadsOut, JSON.stringify(newUploads));
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  main().catch((err) => {
    stderr.write(`storybook-screenshots-upload: ${err?.stack || err}\n`);
    exit(1);
  });
}
