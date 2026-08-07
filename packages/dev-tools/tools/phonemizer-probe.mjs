/**
 * Does the espeak phonemizer work on THIS machine's headless Chromium?
 *
 * `speech-e2e` fails inside `phonemize()` with an empty language set, on CI
 * only — the same package returns 8 voices on a developer laptop. That gap is
 * either the runner's browser or the way the app loads the module, and a
 * 25-minute e2e is a poor instrument for telling those apart. This loads the
 * package by itself, from disk, with no app and no model, and prints what the
 * espeak build reports. Seconds, not minutes.
 *
 * Usage: node packages/dev-tools/tools/phonemizer-probe.mjs
 * Exit code is always 0 — this reports, it does not gate.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const PORT = 4599;
const PKG = 'node_modules/phonemizer/dist/phonemizer.js';

const PAGE = `<!doctype html><meta charset="utf-8">
<script type="module">
  const done = (o) => { window.__result = o; };
  try {
    const m = await import('./phonemizer.js');
    const voices = await m.list_voices();
    let phon = null, err = null;
    try { phon = await m.phonemize('hello world', 'en-us'); }
    catch (e) { err = String((e && e.message) || e); }
    done({ voiceCount: voices.length, sample: voices.slice(0, 3).map((v) => v.identifier ?? v.name), phon, err });
  } catch (e) { done({ fatal: String((e && e.stack) || e) }); }
</script>`;

const server = createServer(async (req, res) => {
  if ((req.url ?? '/').startsWith('/phonemizer.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(await readFile(PKG));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage();
const bad = [];
page.on('console', (m) => console.log(`  [console.${m.type()}] ${m.text().slice(0, 200)}`));
page.on('pageerror', (e) => bad.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => bad.push(`requestfailed: ${r.url()}`));
await page.goto(`http://localhost:${PORT}/`);
await page
  .waitForFunction(() => window.__result != null, null, { timeout: 120_000 })
  .catch(() => bad.push('probe never resolved within 120s'));

console.log(
  'phonemizer probe:',
  JSON.stringify(await page.evaluate(() => window.__result), null, 1)
);
console.log('problems:', bad.length ? bad : 'none');
console.log('chromium:', browser.version());

await browser.close();
server.close();
