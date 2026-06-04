// Wave B7 driver — second-tab election + federated read.
// Opens two tabs (?role=A first, ?role=B ~700ms later) under
// `slicc_opfs_vfs=opfs`. Each tab stashes its `__waveB7Result_<role>`
// in localStorage; we poll both and aggregate.
import { appendFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CDP = process.env.B7_CDP ?? 'http://127.0.0.1:54553';
const BASE_URL =
  process.env.B7_BASE_URL ?? 'http://localhost:5721/packages/webapp/scratch/wave-b7/index.html';
const TIMEOUT_MS = Number(process.env.B7_TIMEOUT_MS ?? 90_000);
const OUT = process.env.B7_TRANSCRIPT ?? new URL('./transcript.txt', import.meta.url).pathname;

writeFileSync(OUT, '');
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  appendFileSync(OUT, line + '\n');
};
log(`=== Wave B7 driver ===`);
log(`CDP=${CDP}`);
log(`BASE=${BASE_URL}`);
log(`time=${new Date().toISOString()}`);

async function openTab(browser, role, transcriptTag) {
  const page = await browser.newPage();
  page.on('console', (msg) => log(`[${transcriptTag} console.${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => log(`[${transcriptTag} pageerror] ${err.message}`));
  page.on('requestfailed', (req) =>
    log(`[${transcriptTag} requestfailed] ${req.url()} :: ${req.failure()?.errorText ?? '?'}`)
  );
  const url = `${BASE_URL}?role=${role}`;
  log(`[${transcriptTag}] goto ${url}`);
  // Set the OPFS flag via an `init` script so it's present before the
  // module bundle resolves `slicc_opfs_vfs`.
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('slicc_opfs_vfs', 'opfs');
    } catch {
      /* no-op */
    }
  });
  const resp = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  log(`[${transcriptTag}] goto status=${resp?.status() ?? '?'} url=${page.url()}`);
  return page;
}

async function pollResult(page, role) {
  return page.evaluate((r) => {
    const direct = globalThis.__waveB7Result ?? null;
    const stored = localStorage.getItem(`__waveB7Result_${r}`);
    return direct ?? (stored ? JSON.parse(stored) : null);
  }, role);
}

let browser = null;
let pageA = null;
let pageB = null;
try {
  browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
  log(`connected to browser`);

  pageA = await openTab(browser, 'A', 'A');
  // Stagger so A wins claim race.
  await new Promise((r) => setTimeout(r, 700));
  pageB = await openTab(browser, 'B', 'B');

  const ctxA = await pageA.evaluate(() => ({
    origin: location.origin,
    isSecureContext: window.isSecureContext,
    hasGetDirectory: typeof navigator?.storage?.getDirectory === 'function',
    flag: localStorage.getItem('slicc_opfs_vfs'),
  }));
  log(`contextA=${JSON.stringify(ctxA)}`);
  const ctxB = await pageB.evaluate(() => ({
    origin: location.origin,
    isSecureContext: window.isSecureContext,
    flag: localStorage.getItem('slicc_opfs_vfs'),
  }));
  log(`contextB=${JSON.stringify(ctxB)}`);

  const deadline = Date.now() + TIMEOUT_MS;
  let resultA = null;
  let resultB = null;
  while (Date.now() < deadline) {
    if (!resultA) resultA = await pollResult(pageA, 'A');
    if (!resultB) resultB = await pollResult(pageB, 'B');
    if (
      resultA &&
      resultB &&
      Array.isArray(resultA.results) &&
      resultA.results.length >= 3 &&
      Array.isArray(resultB.results) &&
      resultB.results.length >= 1
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  log(`--- result.A ---`);
  log(JSON.stringify(resultA, null, 2));
  log(`--- result.B ---`);
  log(JSON.stringify(resultB, null, 2));

  const allResults = [...(resultA?.results ?? []), ...(resultB?.results ?? [])];
  const allPassed =
    !!resultA && !!resultB && allResults.length > 0 && allResults.every((r) => r.status === 'pass');

  // Cross-tab election sanity check (extra guardrail).
  let observedLeaders = 0;
  let observedFollowers = 0;
  if (resultA?.isLeader) observedLeaders++;
  else observedFollowers++;
  if (resultB?.isLeader) observedLeaders++;
  else observedFollowers++;
  log(`leaders=${observedLeaders} followers=${observedFollowers}`);
  const electionOk = observedLeaders === 1 && observedFollowers === 1;
  log(`electionOk=${electionOk}`);

  log(`--- summary ---`);
  log(`allPassed=${allPassed && electionOk}`);
  log(`tabA.isLeader=${resultA?.isLeader} tabB.isLeader=${resultB?.isLeader}`);
  log(`tabA.value=${resultA?.value ?? resultA?.remoteContent}`);
  log(`tabB.remoteContent=${resultB?.remoteContent} tabB.lfsExists=${resultB?.lfsExists}`);
  for (const r of allResults) {
    log(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    if (r.status !== 'pass') {
      log(`  observed=${JSON.stringify(r.observed)}`);
      log(`  expected=${JSON.stringify(r.expected)}`);
    }
  }
  process.exitCode = allPassed && electionOk ? 0 : 1;
} catch (err) {
  log(`DRIVER FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 3;
} finally {
  try {
    if (pageA) await pageA.close();
  } catch {}
  try {
    if (pageB) await pageB.close();
  } catch {}
  try {
    if (browser) await browser.disconnect();
  } catch {}
  log(`done exit=${process.exitCode ?? 0}`);
}
