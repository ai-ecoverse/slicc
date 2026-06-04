// Wave E5 driver — LIVE Pyodide 0.29.4 + real OPFS exit-gate.
// Mirrors D7. Connects to a detached Chrome over CDP, flips the
// `slicc_opfs_vfs=opfs` flag, navigates to the harness page, and
// polls window.__waveE5Result. Writes everything to transcript.txt
// and emits a short summary to stdout.
import { appendFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CDP = process.env.E5_CDP ?? 'http://127.0.0.1:53890';
const TARGET_URL =
  process.env.E5_URL ?? 'http://127.0.0.1:5721/packages/webapp/scratch/wave-e5/index.html';
const TIMEOUT_MS = Number(process.env.E5_TIMEOUT_MS ?? 300_000);
const OUT = process.env.E5_TRANSCRIPT ?? new URL('./transcript.txt', import.meta.url).pathname;

writeFileSync(OUT, '');
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  appendFileSync(OUT, line + '\n');
};
log(`=== Wave E5 driver ===`);
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
  const resp = await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 60_000 });
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
    result = await page.evaluate(() => globalThis.__waveE5Result ?? null);
    if (result) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!result) {
    log(`TIMEOUT no __waveE5Result after ${TIMEOUT_MS}ms`);
    process.exitCode = 2;
  } else {
    log(`--- result ---`);
    log(JSON.stringify(result, null, 2));
    log(`--- summary ---`);
    log(`allPassed=${result.allPassed}`);
    log(`pyodideVersion=${result.pyodideVersion}`);
    log(`pyodideIndexURL=${result.pyodideIndexURL}`);
    log(`bootMs=${result.bootMs} totalMs=${result.totalMs}`);
    log(`exitCode=${result.exitCode}`);
    log(`userCodeSyncfsCount=${result.userCodeSyncfsCount}`);
    log(`fsFilesystemsKeys=${JSON.stringify(result.fsFilesystemsKeys)}`);
    log(`largeFileSize=${result.largeFileSize}`);
    if (result.fatal) log(`FATAL: ${result.fatal}`);
    if (result.stdout) {
      log(`--- python stdout (first 800 chars) ---`);
      log(result.stdout.slice(0, 800));
    }
    if (result.stderr) {
      log(`--- python stderr (first 400 chars) ---`);
      log(result.stderr.slice(0, 400));
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
