// Wave A6 driver — B1 approach.
// Connects to the isolated-instance Chrome via CDP and navigates to a real
// Vite-served harness entry (HTML so __DEV__ + transformIndexHtml apply).
// Polls window.__waveA6Result. Writes everything to transcript.txt; emits
// short summary to stdout.
import { appendFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CDP = process.env.A6_CDP ?? 'http://127.0.0.1:54553';
const TARGET_URL =
  process.env.A6_URL ?? 'http://127.0.0.1:5721/packages/webapp/scratch/wave-a6/index.html';
const TIMEOUT_MS = Number(process.env.A6_TIMEOUT_MS ?? 120_000);
const OUT = process.env.A6_TRANSCRIPT ?? new URL('./transcript.txt', import.meta.url).pathname;

writeFileSync(OUT, '');
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  appendFileSync(OUT, line + '\n');
};
log(`=== Wave A6 driver (B1) ===`);
log(`CDP=${CDP}`);
log(`URL=${URL}`);
log(`time=${new Date().toISOString()}`);

let browser = null;
let page = null;
try {
  browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
  log(`connected to browser`);
  page = await browser.newPage();
  page.on('console', (msg) => log(`[console.${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => log(`[pageerror] ${err.message}`));
  page.on('requestfailed', (req) =>
    log(`[requestfailed] ${req.url()} :: ${req.failure()?.errorText ?? '?'}`)
  );

  log(`goto ${TARGET_URL}`);
  const resp = await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 30_000 });
  log(`goto status=${resp?.status() ?? '?'} url=${page.url()}`);
  const ctx = await page.evaluate(() => ({
    origin: location.origin,
    isSecureContext: window.isSecureContext,
    hasGetDirectory: typeof navigator?.storage?.getDirectory === 'function',
  }));
  log(`context=${JSON.stringify(ctx)}`);

  const deadline = Date.now() + TIMEOUT_MS;
  let result = null;
  while (Date.now() < deadline) {
    result = await page.evaluate(() => globalThis.__waveA6Result ?? null);
    if (result) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!result) {
    log(`TIMEOUT no __waveA6Result after ${TIMEOUT_MS}ms`);
    process.exitCode = 2;
  } else {
    log(`--- result ---`);
    log(JSON.stringify(result, null, 2));
    log(`--- summary ---`);
    log(`allPassed=${result.allPassed}`);
    if (result.fatal) log(`FATAL: ${result.fatal}`);
    for (const r of result.results ?? []) {
      log(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
      if (r.status !== 'pass') {
        log(`  observed=${JSON.stringify(r.observed)}`);
        log(`  expected=${JSON.stringify(r.expected)}`);
      }
    }
    process.exitCode = result.allPassed ? 0 : 1;
  }
} catch (err) {
  log(`DRIVER FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 3;
} finally {
  try {
    if (page) await page.close();
  } catch {}
  try {
    if (browser) await browser.disconnect();
  } catch {}
  log(`done exit=${process.exitCode ?? 0}`);
}
