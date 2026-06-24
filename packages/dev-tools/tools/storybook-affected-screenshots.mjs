#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
/*
 * Screenshot the @slicc/webcomponents Storybook stories affected by a PR diff.
 *
 * Pipeline (the resolver lives in storybook-affected-stories-lib.mjs):
 *   1. Read changed files (--changed-files=<path> or $CHANGED_FILES csv).
 *   2. Read `<storybook-static>/index.json` and resolve affected story IDs.
 *   3. Serve `<storybook-static>` over an ephemeral localhost port (stdlib http).
 *   4. Launch Playwright Chromium at a fixed desktop viewport (1280×900).
 *   5. For each affected story × {light, dark} navigate to
 *      `iframe.html?id=<id>&globals=theme:<theme>` and screenshot to `<out>`.
 *   6. Emit `<out>/manifest.json` (schema below) so the CI workflow (Task 2)
 *      can upload the PNGs and build the sticky PR comment.
 *
 * Manifest schema (v2) — Task 2 reads this:
 *   {
 *     "version": 2,
 *     "generatedAt": ISO8601,
 *     "viewport": { "width": number, "height": number },
 *     "shots": [ {
 *       "storyId": string,         // Storybook ID, e.g. "pill-pill--cone-open-idle"
 *       "title": string,           // e.g. "Pill/Pill"
 *       "name": string,            // e.g. "Cone Open Idle"
 *       "area": string,            // src/<area>/, e.g. "pill"
 *       "importPath": string,      // e.g. "./src/pill/slicc-pill.stories.ts"
 *       "theme": "light" | "dark",
 *       "file": string,            // basename, relative to manifest dir
 *       "contentHash": string,     // SHA-256 hex digest of the PNG file
 *       "triggeredBy": string[]    // repo-relative changed paths that selected this story
 *     } ]
 *   }
 *
 * Usage:
 *   node packages/dev-tools/tools/storybook-affected-screenshots.mjs \
 *     --changed-files=changed.txt --storybook-static=packages/webcomponents/storybook-static \
 *     --out=screenshots
 *
 * Exit codes: 0 = success (incl. "no affected stories"); 2 = bad CLI usage;
 * non-zero on capture failure. Requires Playwright Chromium (`npx playwright install chromium`).
 */
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { resolveAffectedStories, screenshotFileName } from './storybook-affected-stories-lib.mjs';

const VIEWPORT = { width: 1280, height: 900 };
const THEMES = /** @type {const} */ (['light', 'dark']);
const RENDER_TIMEOUT_MS = 15_000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

function parseArgs(args) {
  const out = {};
  for (const a of args.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readChangedFiles(pathOrEnv) {
  if (pathOrEnv && existsSync(pathOrEnv)) {
    return readFileSync(pathOrEnv, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const env = process.env.CHANGED_FILES;
  if (env)
    return env
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

/** Stdlib static server. Path-traversal is rejected; non-files return 404. */
function startStaticServer(rootDir) {
  const root = resolve(rootDir);
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = url === '/' ? '/index.html' : url;
    const abs = resolve(root, '.' + rel);
    if (!abs.startsWith(root) || !existsSync(abs)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream' });
    createReadStream(abs).pipe(res);
  });
  return new Promise((resolveReady) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolveReady({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** Calculate SHA-256 hash of a file. */
function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function captureOne(page, baseUrl, storyId, theme, outFile) {
  // Storybook 10 reads `theme` from the toolbar via globals=key:value (semicolon-separated for multiple).
  const url = `${baseUrl}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story&globals=theme:${theme}`;
  await page.goto(url, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
  // Wait until Storybook has mounted SOMETHING into the root container.
  await page.waitForFunction(
    () => {
      const root = document.querySelector('#storybook-root') || document.querySelector('#root');
      return !!root && root.children.length > 0;
    },
    null,
    { timeout: RENDER_TIMEOUT_MS }
  );
  // Small settle pass for any async icon/font work in the component itself.
  await page.waitForTimeout(150);
  await page.screenshot({ path: outFile, fullPage: false });
}

async function main() {
  const args = parseArgs(argv);
  const staticDir = args['storybook-static'];
  const outDir = args.out;
  if (!staticDir || !outDir) {
    stderr.write(
      'usage: storybook-affected-screenshots.mjs --storybook-static=<dir> --out=<dir> [--changed-files=<path>]\n'
    );
    exit(2);
  }
  const indexPath = join(staticDir, 'index.json');
  if (!existsSync(indexPath)) {
    stderr.write(
      `index.json not found at ${indexPath} — run "npm run build-storybook -w @slicc/webcomponents" first\n`
    );
    exit(2);
  }
  const indexJson = JSON.parse(readFileSync(indexPath, 'utf8'));
  const changed = readChangedFiles(args['changed-files']);
  const affected = resolveAffectedStories(changed, indexJson);

  mkdirSync(outDir, { recursive: true });
  const manifest = {
    version: 2,
    generatedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    shots: /** @type {object[]} */ ([]),
  };

  if (affected.length === 0) {
    stdout.write('No affected stories for given changed files — writing empty manifest.\n');
    writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  stdout.write(`Resolved ${affected.length} affected story/ies; capturing light+dark…\n`);
  const { chromium } = await import('playwright');
  const server = await startStaticServer(staticDir);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    for (const story of affected) {
      for (const theme of THEMES) {
        const fileName = screenshotFileName(story.storyId, theme);
        const outFile = join(outDir, fileName);
        await captureOne(page, baseUrl, story.storyId, theme, outFile);
        const contentHash = await calculateFileHash(outFile);
        stdout.write(
          `  ✓ ${story.storyId} [${theme}] → ${fileName} (${contentHash.slice(0, 8)}…)\n`
        );
        manifest.shots.push({
          storyId: story.storyId,
          title: story.title,
          name: story.name,
          area: story.area,
          importPath: story.importPath,
          theme,
          file: fileName,
          contentHash,
          triggeredBy: story.triggeredBy,
        });
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  stdout.write(`Wrote ${manifest.shots.length} screenshot(s) + manifest.json under ${outDir}\n`);
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  main().catch((err) => {
    stderr.write(`storybook-affected-screenshots: ${err?.stack || err}\n`);
    exit(1);
  });
}
