// pcli-e2e — automate the deterministic, programmatically-checkable groups of the
// playwright-cli end-to-end test session and emit a PASS/FAIL table + structured JSON.
//
// Companion to /workspace/skills/playwright-cli-e2e/SKILL.md. The interactive/visual
// groups (Mouse feel, highlight rendering, HAR contents, dialogs) still need the manual
// checklist in SKILL.md — those need human/visual judgment and aren't automated here.
//
// Each automated check is compared against the known baseline (see BASELINE below). A
// result is flagged "matches baseline", "REGRESSION" (was PASS, now FAIL), or
// "IMPROVEMENT" (was a known bug, now PASS) so successive runs can be diffed.
//
// Environment notes baked into the checks (learned the hard way — do not "simplify" away):
//   * `open <vfs-path>` renders about:blank — the fixture is loaded as a data: URL.
//   * Route mocking + console capture DO NOT work on a data: (opaque) origin — those two
//     checks run on a real-origin helper tab (example.com), not the fixture tab.
//   * The main-document navigation is often NOT captured by `requests`; a page-context
//     fetch reliably is — the network check triggers one.
//   * `/tmp` is CLI-internal and invisible to the fs bridge — screenshots go under cwd.
//
// Usage:
//   pcli-e2e            Run all automated checks, print table + JSON, clean up tabs.
//   pcli-e2e --help     Show this usage.

const { exec } = require('sliccy:exec');
const fs = require('fs');
const cli = require('sliccy:cli');
const c = require('sliccy:color');

const { flags } = process.argv.parseFlags();

if (flags.help || flags.h) {
  cli.help(`pcli-e2e — automated playwright-cli regression checks

Usage:
  pcli-e2e            Run the deterministic checks (route mock, console, network,
                      screenshot-options bug, ref-resolution bug, generate-locator
                      validity, fetch/discover), print a PASS/FAIL table + JSON,
                      and close any tab it opened.
  pcli-e2e --help     Show this message.

Each check is compared against the known baseline (8 PASS / 3 FAIL bugs). Findings are
flagged matches-baseline / REGRESSION / IMPROVEMENT. The interactive/visual groups
(Mouse, highlight, HAR contents, dialogs) need the manual checklist in SKILL.md.`);
  process.exit(0);
}

// ----- Known baseline (from /shared/playwright-cli-e2e-report.md, 2026-06-25) -----
// expect: 'PASS' = group worked; 'BUG' = group had a confirmed bug (expected FAIL).
const BASELINE = {
  'route-mocking': 'PASS',
  console: 'PASS',
  'network-capture': 'PASS',
  'fetch-discover': 'PASS',
  'screenshot-options': 'PASS', // fixed: fullPage/maxWidth/element now produce different output
  'ref-resolution': 'PASS', // fixed: autoSaveSnapshot populates in-memory state after click
  'generate-locator': 'PASS', // fixed: backendNodeId populated from CDP Accessibility domain
};

const FIXTURE = `${__dirname}/test-fixture.html`;
const SHOTS = `${process.cwd()}/.pcli-e2e-shots`;
const HELPER_ORIGIN = 'https://example.com';

const results = [];
let fixtureTab = null;
let helperTab = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(id, group, ok, evidence) {
  const expect = BASELINE[id];
  const realStatus = ok ? 'PASS' : 'FAIL';
  let flag, matchesBaseline;
  if (expect === 'PASS') {
    matchesBaseline = ok;
    flag = ok ? 'matches baseline' : 'REGRESSION (was PASS, now FAIL)';
  } else {
    // expect === 'BUG' — baseline FAIL. ok===false means bug still present (matches).
    matchesBaseline = !ok;
    flag = ok ? 'IMPROVEMENT (was known-bug, now PASS)' : 'matches baseline (known bug present)';
  }
  results.push({ id, group, realStatus, baseline: expect, matchesBaseline, flag, evidence });
}

async function pw(args) {
  return exec(`playwright-cli ${args}`);
}

function parseTargetId(text) {
  const m = String(text).match(/targetId:\s*([0-9A-Za-z]+)/);
  return m ? m[1] : null;
}

async function openTab(url) {
  const res = await exec.spawn(['playwright-cli', 'open', url]);
  const id = parseTargetId(`${res.stdout}\n${res.stderr}`);
  if (!id) throw new Error(`could not parse targetId from open: ${res.stdout} ${res.stderr}`);
  return id;
}

// ----- Setup: load the fixture as a data: URL (open <vfs-path> renders about:blank) -----
async function openFixture() {
  const html = await fs.readFile(FIXTURE);
  const b64 = Buffer.from(html, 'utf8').toString('base64');
  fixtureTab = await openTab(`data:text/html;base64,${b64}`);
  const title = await pw(`eval --tab=${fixtureTab} "document.title"`);
  if (!/E2E Test Page/.test(title.stdout)) {
    throw new Error(`fixture did not load; eval title => ${title.stdout.trim()}`);
  }
}

// ----- Check: route mocking (baseline PASS). Real origin required (data: blocks it). -----
async function checkRouteMocking(tab) {
  try {
    await pw(`route --tab=${tab} "**/pcli-e2e-mock*" --status=200 --body='{"mocked":true}' --content-type=application/json`);
    const list = await pw(`route-list --tab=${tab}`);
    const got = await pw(
      `eval --tab=${tab} "fetch('${HELPER_ORIGIN}/pcli-e2e-mock').then(r=>r.text())"`
    );
    await pw(`unroute --tab=${tab}`);
    const ok = /"mocked":\s*true/.test(got.stdout);
    record('route-mocking', 'Route mocking', ok, {
      routeList: list.stdout.trim().slice(0, 120),
      mockResponse: got.stdout.trim().slice(0, 160),
    });
  } catch (e) {
    record('route-mocking', 'Route mocking', false, { error: String(e.message || e) });
  }
}

// ----- Check: console capture + --clear (baseline PASS). Real origin required. -----
async function checkConsole(tab) {
  try {
    // The console capture listener attaches lazily — the FIRST log emitted right after
    // a tab opens is reliably missed. Fire a warm-up log, wait, then the real ones.
    await pw(`eval --tab=${tab} "console.log('pcli-warmup');1"`);
    await sleep(500);
    await pw(`console --tab=${tab} --clear`); // drop the warm-up so it can't pollute the sample
    await pw(`eval --tab=${tab} "console.log('pcli-log');console.warn('pcli-warn');console.error('pcli-err');1"`);
    await sleep(600);
    const dump = await pw(`console --tab=${tab} --clear`);
    const sawAll =
      /pcli-log/.test(dump.stdout) && /pcli-warn/.test(dump.stdout) && /pcli-err/.test(dump.stdout);
    const after = await pw(`console --tab=${tab}`);
    const cleared = /No console messages/i.test(after.stdout);
    record('console', 'Console', sawAll && cleared, {
      captured: sawAll,
      clearedAfter: cleared,
      sample: dump.stdout.trim().split('\n').slice(0, 3),
    });
  } catch (e) {
    record('console', 'Console', false, { error: String(e.message || e) });
  }
}

// ----- Check: network capture (baseline PASS). Trigger a page-context fetch — the main
// document navigation is not reliably captured, but a fetch is. -----
async function checkNetwork(tab) {
  try {
    await pw(`requests --clear --tab=${tab}`);
    await pw(`eval --tab=${tab} "fetch('${HELPER_ORIGIN}/?pcli-e2e-net').then(r=>r.status)"`);
    await sleep(1200);
    const reqs = await pw(`requests --tab=${tab}`);
    const hasEntries = !/No requests/i.test(reqs.stdout) && /https?:\/\//.test(reqs.stdout);
    const detail = await pw(`request 1 --tab=${tab}`);
    const respH = await pw(`response-headers 1 --tab=${tab}`);
    const ok =
      hasEntries &&
      /https?:\/\//.test(detail.stdout) &&
      !/No request at index/i.test(respH.stdout) &&
      respH.stdout.trim().length > 0;
    record('network-capture', 'Network capture', ok, {
      requestsHead: reqs.stdout.trim().split('\n').slice(0, 2),
      detailHasUrl: /https?:\/\//.test(detail.stdout),
      responseHeadersLen: respH.stdout.trim().length,
    });
  } catch (e) {
    record('network-capture', 'Network capture', false, { error: String(e.message || e) });
  }
}

// Read PNG IHDR width/height (bytes 16-23, big-endian) directly from a file.
async function pngDims(path) {
  if (!(await fs.exists(path))) return null;
  const buf = await fs.readFileBinary(path); // Uint8Array
  if (!buf || buf.length < 24) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  const be = (o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
  return { width: be(16), height: be(20), bytes: buf.length };
}

async function md5(path) {
  if (!(await fs.exists(path))) return null;
  const r = await exec.spawn(['md5sum', path]);
  return (r.stdout || '').trim().split(/\s+/)[0] || null;
}

// ----- Check: screenshot-options bug detector (baseline BUG) -----
// Check PASSES (bug fixed) only if the option variants visibly change the output.
// Byte-identical / same-dimension output => bug still present => matches baseline.
async function checkScreenshotOptions(tab) {
  try {
    await exec.spawn(['mkdir', '-p', SHOTS]);
    const def = `${SHOTS}/default.png`;
    const full = `${SHOTS}/full.png`;
    const small = `${SHOTS}/small.png`;
    await pw(`screenshot --tab=${tab} --filename=${def}`);
    await pw(`screenshot --tab=${tab} --filename=${full} --fullPage=true`);
    await pw(`screenshot --tab=${tab} --filename=${small} --max-width=400`);
    const [dDef, dFull, dSmall] = await Promise.all([pngDims(def), pngDims(full), pngDims(small)]);
    const [mDef, mFull, mSmall] = await Promise.all([md5(def), md5(full), md5(small)]);
    const allSameMd5 = !!(mDef && mDef === mFull && mDef === mSmall);
    const fullPageHonored = !!(dDef && dFull && dFull.height > dDef.height);
    const maxWidthHonored = !!(dDef && dSmall && dSmall.width < dDef.width);
    const ok = !allSameMd5 && (fullPageHonored || maxWidthHonored);
    record('screenshot-options', 'Screenshots (options)', ok, {
      md5: { default: mDef, fullPage: mFull, maxWidth: mSmall },
      dims: { default: dDef, fullPage: dFull, maxWidth: dSmall },
      allByteIdentical: allSameMd5,
      fullPageHonored,
      maxWidthHonored,
    });
    await exec.spawn(['rm', '-rf', SHOTS]);
  } catch (e) {
    record('screenshot-options', 'Screenshots (options)', false, { error: String(e.message || e) });
  }
}

// Grab an interactive ref of a given role from a snapshot.
function findRef(snapshotText, rolePattern) {
  const re = new RegExp(`${rolePattern}[^\\n]*\\[ref=(e\\d+)\\]`);
  const m = snapshotText.match(re);
  return m ? m[1] : null;
}

// ----- Check: ref-resolution bug detector (baseline BUG) -----
// hover/select/check errored "Unknown ref" right after a snapshot that listed the ref.
async function checkRefResolution(tab) {
  try {
    const snap = await pw(`snapshot --tab=${tab}`);
    const comboRef = findRef(snap.stdout, 'combobox');
    const checkRef = findRef(snap.stdout, 'checkbox');
    if (!comboRef && !checkRef) {
      record('ref-resolution', 'Interaction (ref resolution)', false, {
        error: 'no combobox/checkbox ref found in snapshot',
        snapshotHead: snap.stdout.trim().split('\n').slice(0, 8),
      });
      return;
    }
    const evidence = { comboRef, checkRef };
    let anySuccess = false;
    let anyUnknownRef = false;
    if (comboRef) {
      const sel = await pw(`select --tab=${tab} ${comboRef} green`);
      const out = `${sel.stdout}\n${sel.stderr}`;
      evidence.select = out.trim().slice(0, 120);
      if (/Unknown ref/i.test(out)) anyUnknownRef = true;
      else if (/select|green/i.test(out) && !/error/i.test(out)) anySuccess = true;
    }
    if (checkRef) {
      const chk = await pw(`check --tab=${tab} ${checkRef}`);
      const out = `${chk.stdout}\n${chk.stderr}`;
      evidence.check = out.trim().slice(0, 120);
      if (/Unknown ref/i.test(out)) anyUnknownRef = true;
      else if (/check/i.test(out) && !/error/i.test(out)) anySuccess = true;
    }
    const ok = anySuccess && !anyUnknownRef;
    evidence.unknownRefSeen = anyUnknownRef;
    record('ref-resolution', 'Interaction (ref resolution)', ok, evidence);
  } catch (e) {
    record('ref-resolution', 'Interaction (ref resolution)', false, { error: String(e.message || e) });
  }
}

// ----- Check: generate-locator validity (baseline BUG) -----
// Generate a locator for the text-named button, then verify the CSS selector inside it
// actually matches an element. NULL match => bug present.
async function checkGenerateLocator(tab) {
  try {
    const snap = await pw(`snapshot --tab=${tab}`);
    const btnRef = findRef(snap.stdout, 'button');
    if (!btnRef) {
      record('generate-locator', 'Visual / locator', false, { error: 'no button ref found in snapshot' });
      return;
    }
    const loc = await pw(`generate-locator --tab=${tab} ${btnRef}`);
    const locStr = loc.stdout.trim();
    const m = locStr.match(/locator\((["'])([\s\S]*?)\1\)/);
    const selector = m ? m[2].replace(/\\"/g, '"').replace(/\\'/g, "'") : null;
    let matches = null;
    if (selector) {
      const safe = selector.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const q = await pw(`eval --tab=${tab} "document.querySelector(\\"${safe}\\") ? 'MATCH' : 'NULL'"`);
      matches = /MATCH/.test(q.stdout) ? 'MATCH' : /NULL/.test(q.stdout) ? 'NULL' : `?(${q.stdout.trim()})`;
    }
    const ok = matches === 'MATCH';
    record('generate-locator', 'Visual / locator', ok, {
      ref: btnRef,
      locator: locStr.slice(0, 160),
      selector,
      querySelector: matches,
    });
  } catch (e) {
    record('generate-locator', 'Visual / locator', false, { error: String(e.message || e) });
  }
}

// ----- Check: fetch / discover (baseline PASS) -----
async function checkFetchDiscover() {
  try {
    const res = await pw(`fetch ${HELPER_ORIGIN} --discover`);
    let json = null;
    try {
      json = JSON.parse(res.stdout);
    } catch {}
    const ok =
      json &&
      typeof json.status === 'number' &&
      Array.isArray(json.links) &&
      Object.prototype.hasOwnProperty.call(json, 'discovery');
    record('fetch-discover', 'fetch / discover', !!ok, {
      status: json ? json.status : null,
      hasLinks: json ? Array.isArray(json.links) : false,
      hasDiscovery: json ? Object.prototype.hasOwnProperty.call(json, 'discovery') : false,
    });
  } catch (e) {
    record('fetch-discover', 'fetch / discover', false, { error: String(e.message || e) });
  }
}

// ----- Run -----
let runError = null;
try {
  await openFixture();
  helperTab = await openTab(HELPER_ORIGIN);
  // Real-origin checks (data: origin breaks route mocking + console capture).
  await checkRouteMocking(helperTab);
  await checkConsole(helperTab);
  await checkNetwork(helperTab);
  await checkFetchDiscover();
  // Fixture-tab checks.
  await checkScreenshotOptions(fixtureTab);
  await checkRefResolution(fixtureTab);
  await checkGenerateLocator(fixtureTab);
} catch (e) {
  runError = String(e && e.message ? e.message : e);
  console.error(c.red(`pcli-e2e: ${runError}`));
} finally {
  for (const t of [fixtureTab, helperTab]) {
    if (!t) continue;
    try {
      await pw(`tab-close --tab=${t}`);
    } catch {
      // tab already gone — fine.
    }
  }
}

// ----- Report -----
function pad(s, n) {
  const visible = String(s).replace(/\x1b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, n - visible.length));
}

const passCount = results.filter((r) => r.realStatus === 'PASS').length;
const failCount = results.filter((r) => r.realStatus === 'FAIL').length;
const regressions = results.filter((r) => r.flag.startsWith('REGRESSION'));
const improvements = results.filter((r) => r.flag.startsWith('IMPROVEMENT'));
const mismatches = results.filter((r) => !r.matchesBaseline);

const statusCell = (r) => (r.realStatus === 'PASS' ? c.green('PASS') : c.red('FAIL'));
const flagCell = (r) =>
  r.flag.startsWith('REGRESSION')
    ? c.red(r.flag)
    : r.flag.startsWith('IMPROVEMENT')
      ? c.green(r.flag)
      : c.dim(r.flag);

console.log('');
console.log(c.bold('playwright-cli E2E — automated checks'));
console.log('─'.repeat(82));
console.log([pad('GROUP', 28), pad('STATUS', 8), pad('BASE', 6), 'vs BASELINE'].join(' '));
console.log('─'.repeat(82));
for (const r of results) {
  console.log(
    [pad(r.group, 28), pad(statusCell(r), 8), pad(r.baseline === 'BUG' ? 'BUG' : 'PASS', 6), flagCell(r)].join(' ')
  );
}
console.log('─'.repeat(82));
console.log(
  `Automated: ${passCount} PASS, ${failCount} FAIL of ${results.length} checks. ` +
    (mismatches.length === 0
      ? c.green('All match baseline.')
      : c.yellow(`${mismatches.length} differ from baseline.`))
);
if (regressions.length) console.log(c.red(`REGRESSIONS: ${regressions.map((r) => r.group).join(', ')}`));
if (improvements.length) console.log(c.green(`IMPROVEMENTS: ${improvements.map((r) => r.group).join(', ')}`));
console.log(
  c.dim('Manual/visual groups (Mouse, highlight, HAR contents, dialogs): see SKILL.md checklist.')
);
console.log('');

cli.out({
  tool: 'pcli-e2e',
  ranAt: new Date().toISOString(),
  fixture: FIXTURE,
  fixtureTab,
  helperTab,
  runError,
  summary: {
    automatedChecks: results.length,
    pass: passCount,
    fail: failCount,
    matchesBaseline: mismatches.length === 0,
    regressions: regressions.map((r) => r.id),
    improvements: improvements.map((r) => r.id),
  },
  checks: results,
  baseline: BASELINE,
});

process.exit(runError ? 1 : 0);
