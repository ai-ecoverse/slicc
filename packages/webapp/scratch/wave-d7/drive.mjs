// Wave D7 driver — LIVE Pyodide 0.29.4 + real OPFS round-trip.
// Connects to a detached Chrome over CDP and navigates to the
// Vite-served harness page with the `slicc_opfs_vfs=opfs` flag.
// Polls window.__waveD7Result until ready; writes everything to
// transcript.txt; emits a short summary to stdout.
import { appendFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CDP = process.env.D7_CDP ?? 'http://127.0.0.1:53890';
const TARGET_URL =
  process.env.D7_URL ?? 'http://127.0.0.1:5721/packages/webapp/scratch/wave-d7/index.html';
const TIMEOUT_MS = Number(process.env.D7_TIMEOUT_MS ?? 240_000);
const OUT = process.env.D7_TRANSCRIPT ?? new URL('./transcript.txt', import.meta.url).pathname;

writeFileSync(OUT, '');
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  appendFileSync(OUT, line + '\n');
};
log(`=== Wave D7 driver ===`);
log(`CDP=${CDP}`);
log(`URL=${TARGET_URL}`);
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
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('slicc_opfs_vfs', 'opfs');
    } catch {
      /* no-op */
    }
  });
  log(`goto ${TARGET_URL}`);
  const resp = await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 30_000 });
  log(`goto status=${resp?.status() ?? '?'} url=${page.url()}`);
  const ctx = await page.evaluate(() => ({
    origin: location.origin,
    isSecureContext: window.isSecureContext,
    hasGetDirectory: typeof navigator?.storage?.getDirectory === 'function',
    flag: localStorage.getItem('slicc_opfs_vfs'),
    userAgent: navigator.userAgent,
  }));
  log(`context=${JSON.stringify(ctx)}`);

  const deadline = Date.now() + TIMEOUT_MS;
  let result = null;
  while (Date.now() < deadline) {
    result = await page.evaluate(() => globalThis.__waveD7Result ?? null);
    if (result) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!result) {
    log(`TIMEOUT no __waveD7Result after ${TIMEOUT_MS}ms`);
    process.exitCode = 2;
  } else {
    log(`--- result ---`);
    log(JSON.stringify(result, null, 2));
    log(`--- summary ---`);
    log(`allPassed=${result.allPassed}`);
    log(`pyodideVersion=${result.pyodideVersion}`);
    log(`pyodideIndexURL=${result.pyodideIndexURL}`);
    log(`bootMs=${result.bootMs} totalMs=${result.totalMs}`);
    if (result.fatal) log(`FATAL: ${result.fatal}`);
    if (result.stdout) {
      log(`--- python stdout (first 400 chars) ---`);
      log(result.stdout.slice(0, 400));
    }
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
