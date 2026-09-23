// run-task.jsh — runs one benchmark task on a SLICC leader and records the evidence.
//
//   node /tmp/bench/run-task.jsh <run-id> <model> [timeout-seconds] [thinking]
//
// Reads /tmp/bench/<run-id>/prompt.txt, closes every browser tab, and spawns one `agent` scoop
// with that prompt, so each task starts from a fresh context. Writes
// /tmp/bench/<run-id>/result.json: the scoop's final message and exit code, wall time, the
// scoops' spend from `cost --json` (the cone excluded), the persisted transcript, screenshots
// taken during the run plus any the agent saved, and the files it wrote to its working
// directory. Copied to the leader by packages/bench/scripts/slicc-adapter.mjs.
//
// Screenshots are taken while the agent works, as browser-use's harness does: agents close
// their tabs when they finish (the playwright-cli skill asks them to), so the end state is
// often gone by the time the run returns. Every few seconds each open tab is captured when its
// address changed or the last capture is old; identical consecutive frames are dropped.

const fs = require('fs');
const exec = require('sliccy:exec');

const [runId, model, timeoutArg, thinking] = process.argv.slice(2);
if (!runId || !model) {
  console.error('usage: run-task.jsh <run-id> <model> [timeout-seconds] [thinking]');
  process.exit(2);
}
const dir = `/tmp/bench/${runId}`;
const timeoutMs = Math.max(30, Number(timeoutArg) || 900) * 1000;
const MAX_SCREENSHOTS = 10;
const POLL_MS = 4000;
const RECAPTURE_MS = 15000;
const MAX_FILE_BYTES = 200 * 1024;
const OWN_FILES = new Set(['prompt.txt', 'result.json']);

async function sh(argv) {
  return exec.spawn(argv);
}

async function tabs() {
  const r = await sh(['playwright-cli', 'tab-list']);
  return [...(r.stdout || '').matchAll(/^\[([^\]]+)\]\s+(\S+)/gm)].map((m) => ({ id: m[1], url: m[2] }));
}

async function scoopCosts() {
  const r = await sh(['cost', '--json', '--all']);
  try {
    return (JSON.parse(r.stdout).scoops || []).filter((s) => s.type !== 'cone');
  } catch {
    return [];
  }
}

async function list(path) {
  try {
    return (await fs.readDir(path)).map((e) => (typeof e === 'string' ? e : e.name));
  } catch {
    return [];
  }
}

async function mtime(path) {
  try {
    const st = await fs.stat(path);
    return Number(st.mtimeMs ?? (st.mtime ? new Date(st.mtime).getTime() : 0));
  } catch {
    return 0;
  }
}

async function base64Of(path) {
  const bytes = await fs.readFileBinary(path);
  return Buffer.from(bytes).toString('base64');
}

// Screenshot directories a scoop's playwright-cli may write: its own scratch tree
// (/tmp/<cone>/<scoop>/.playwright, ai-ecoverse/slicc#3444) and, on older builds, /.playwright.
async function screenshotDirs() {
  const dirs = ['/.playwright/screenshots'];
  for (const a of await list('/tmp')) {
    for (const b of await list(`/tmp/${a}`)) dirs.push(`/tmp/${a}/${b}/.playwright/screenshots`);
  }
  return dirs;
}

const prompt = await fs.readFile(`${dir}/prompt.txt`);
for (const t of await tabs()) await sh(['playwright-cli', 'tab-close', `--tab=${t.id}`]);
const before = await scoopCosts();
const sessionsBefore = new Set(await list('/sessions'));
const started = Date.now();

const shots = [];
const lastUrl = new Map();
const lastAt = new Map();
let seq = 0;
async function capture(final) {
  for (const t of await tabs()) {
    const now = Date.now();
    if (!final && lastUrl.get(t.id) === t.url && now - (lastAt.get(t.id) || 0) < RECAPTURE_MS) continue;
    seq += 1;
    const path = `${dir}/shot-${String(seq).padStart(3, '0')}.png`;
    const r = await sh(['playwright-cli', 'screenshot', `--tab=${t.id}`, `--filename=${path}`, '--max-width=1280']);
    if (r.exitCode === 0 && (await fs.exists(path))) {
      shots.push({ label: `${Math.round((now - started) / 1000)} s into the run, ${t.url}`, path });
      lastUrl.set(t.id, t.url);
      lastAt.set(t.id, now);
    }
  }
}

const argv = ['agent', '--model', model, '--persist-session'];
if (thinking) argv.push('--thinking', thinking);
argv.push(dir, '*', prompt);
const handle = exec.start(argv);
handle.stdin.end();
let timedOut = false;
let running = true;
const timer = setTimeout(() => {
  timedOut = true;
  handle.kill('SIGTERM');
}, timeoutMs);
const poller = (async () => {
  while (running) {
    await capture(false).catch(() => {});
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
const run = await handle.done;
running = false;
clearTimeout(timer);
const durationMs = Date.now() - started;
await poller;
await capture(true).catch(() => {});

const after = await scoopCosts();
const beforeByName = new Map(before.map((s) => [s.name, s]));
let costUsd = 0;
let tokens = 0;
let turns = 0;
const scoops = [];
for (const s of after) {
  const prev = beforeByName.get(s.name);
  const dCost = (s.usage?.cost?.total || 0) - (prev?.usage?.cost?.total || 0);
  const dTokens = (s.usage?.totalTokens || 0) - (prev?.usage?.totalTokens || 0);
  if (dCost > 0 || dTokens > 0) {
    costUsd += dCost;
    tokens += dTokens;
    turns += (s.turns || 0) - (prev?.turns || 0);
    scoops.push(s.name);
  }
}

const newArchives = (await list('/sessions')).filter((n) => /^agent-.*\.md$/.test(n) && !sessionsBefore.has(n));
const archivePath = newArchives.length ? `/sessions/${newArchives.sort().pop()}` : null;
const archive = archivePath ? await fs.readFile(archivePath) : '';

const openTabs = await tabs();
const screenshots = [];
for (const d of await screenshotDirs()) {
  for (const name of (await list(d)).sort()) {
    const path = `${d}/${name}`;
    if (/\.(png|jpe?g)$/i.test(name) && (await mtime(path)) >= started) {
      screenshots.push({ label: `saved by the agent: ${name}`, path });
    }
  }
}
screenshots.push(...shots);
const images = [];
let previous = null;
for (const s of screenshots) {
  try {
    const base64 = await base64Of(s.path);
    if (base64 === previous) continue;
    previous = base64;
    images.push({ label: s.label, format: /\.jpe?g$/i.test(s.path) ? 'jpeg' : 'png', base64 });
  } catch {
    // An unreadable screenshot is dropped; the others still reach the judge.
  }
}
const keptImages = images.slice(-MAX_SCREENSHOTS);

const outputFiles = [];
for (const name of await list(dir)) {
  if (OWN_FILES.has(name) || /^shot-\d+\.png$/.test(name)) continue;
  const path = `${dir}/${name}`;
  try {
    const st = await fs.stat(path);
    if (st.isDirectory?.() || st.size > MAX_FILE_BYTES) {
      outputFiles.push({ path, text: null, size: st.size });
      continue;
    }
    outputFiles.push({ path, text: await fs.readFile(path), size: st.size });
  } catch {
    outputFiles.push({ path, text: null });
  }
}

await fs.writeFile(
  `${dir}/result.json`,
  JSON.stringify({
    runId,
    model,
    thinking: thinking || null,
    exitCode: run.exitCode,
    timedOut,
    finalText: run.stdout || '',
    stderr: (run.stderr || '').slice(-4000),
    durationMs,
    costUsd,
    tokens,
    turns,
    scoops,
    archivePath,
    archive,
    tabs: openTabs.map((t) => t.url),
    screenshots: keptImages,
    screenshotsTaken: images.length,
    outputFiles,
  })
);
console.log(`${dir}/result.json`);
