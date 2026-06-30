// Shared helpers for the slicc-lickback-handler operator scripts. Pure logic is
// exported and unit-tested; the two fetch helpers are integration-tested against
// a node:http fake cup. Each script is a thin wrapper over this module, so all
// branching logic lives here where it can be tested without spawning.
// tva
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 5710;
export const DEFAULT_CHANNEL = 'chat';
const DEFAULT_TIMEOUT_MS = 10_000;

/** SLICC runtime-state dir. `SLICC_DIR` overrides it (tests; never the real ~/.slicc). */
export function sliccDir() {
  return process.env.SLICC_DIR || join(homedir(), '.slicc');
}
export function lickbackDir() {
  return join(sliccDir(), 'lickback');
}
/** Where bootstrap drain-pidfiles live (one per running drain, named `<cupPort>-<pid>`),
 *  so a new brain can reap a prior session's orphaned drain before claiming. */
export function drainsDir(dir = lickbackDir()) {
  return join(dir, 'drains');
}
export function cupDiscoveryPath(dir = sliccDir()) {
  return join(dir, 'cup.json');
}

/** Buffer + cursor paths for one (session, channel) — stable across processes so
 *  a background drain and a foreground `next` agree without IPC. */
export function bufferPathsFor(session, channel = DEFAULT_CHANNEL, dir = lickbackDir()) {
  const safe = `${session}-${channel}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return { ndjson: join(dir, `${safe}.ndjson`), cursor: join(dir, `${safe}.cursor`) };
}

/** Parse + validate a cup.json string (mirrors node-server/src/cup-discovery.ts). */
export function parseCupRecord(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { port, pid, startedAt } = parsed;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535)
    return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== 'string' || startedAt.length === 0) return null;
  return { port, pid, startedAt };
}

export function readCupRecord(dir = sliccDir()) {
  let raw;
  try {
    raw = readFileSync(cupDiscoveryPath(dir), 'utf-8');
  } catch {
    return null;
  }
  return parseCupRecord(raw);
}

export function resolvePort(record) {
  return record && typeof record.port === 'number' ? record.port : DEFAULT_PORT;
}
export function baseUrlForPort(port) {
  return `http://127.0.0.1:${port}`;
}

/** Probe GET /api/status; true only when the server self-identifies as a cup. */
export async function probeCup(base, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await fetchImpl(`${base}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.cup === true;
  } catch {
    return false;
  }
}

/** Bridge-ready probe: GET /api/targets returns 200 only once the cup's browser has
 *  connected AND the cup shell-bridge handler is registered (it 500s / "Unknown request
 *  type" otherwise — e.g. a cone-less PRODUCTION webapp that predates this feature). Use
 *  this — NOT probeCup (/api/status, which is up before the browser) — to know a cup is
 *  actually DRIVABLE. */
export async function probeCupBridgeReady(base, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await fetchImpl(`${base}/api/targets`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** True when `url` answers with ANY HTTP response (even 404) — i.e. something is listening
 *  there. Used to detect a live wrangler dev server on :8787 before launching cup-dev. */
export async function probeHttpUp(url, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** Poll `probe()` up to `attempts` times (sleeping `intervalMs` between), resolving true
 *  the moment it passes or false after the budget. Pure: inject `probe`/`sleep`. */
export async function waitUntil(probe, { sleep, attempts = 60, intervalMs = 1000 }) {
  for (let i = 0; i < attempts; i++) {
    if (await probe()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** The repo clone's current git branch, or null outside a clone / on error.
 *  Single source for the dev-vs-prod heuristic shared by cup-up + cup-lead. */
export function gitBranch(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Extract the tray join URL from `host` command output — the `join_url: <url>`
 *  line. Returns the URL only once it's a real `http(s)://…` value; `host` prints
 *  `join_url: unavailable` (or omits it) until leadership is actually established,
 *  so cup-lead can poll on a null return. */
export function parseJoinUrl(hostOutput) {
  for (const line of (hostOutput ?? '').split('\n')) {
    const m = line.match(/^\s*join_url:\s*(\S+)/);
    if (m && /^https?:\/\//.test(m[1])) return m[1];
  }
  return null;
}

/** Fire `host lead [workerArg]` then poll `host` until a join URL appears (#18 —
 *  collapses the fire-turn + poll-turn into one script call). `exec(command)` is
 *  injected (returns the command's stdout) so the lead/poll flow is unit-testable
 *  without a cup; resolves the join URL or null after the budget. */
export async function leadAndPoll({
  exec,
  sleep,
  workerArg = '',
  attempts = 30,
  intervalMs = 1000,
}) {
  await exec(`host lead${workerArg ? ` ${workerArg}` : ''}`);
  for (let i = 0; i < attempts; i++) {
    const url = parseJoinUrl(await exec('host'));
    if (url) return url;
    await sleep(intervalMs);
  }
  return null;
}

/** Assemble the cup bootstrap bundle (#18): concatenate the fetched SLICC docs
 *  into ONE sectioned blob the brain reads in a single tool result, with a clear
 *  delimiter per source. A section that failed to load is marked `(unavailable)`
 *  rather than dropped, so a missing skill is visible, not silently swallowed.
 *  `sections` is `[{ title, body }]`. Pure for unit testing. */
export function assembleBootstrap(sections) {
  return sections
    .map(({ title, body }) => `===== ${title} =====\n${body?.length ? body : '(unavailable)'}`)
    .join('\n\n');
}

/** Run a shell command on the cup via POST /api/shell/exec; returns stdout (''
 *  on a non-ok response or missing field). The thin transport behind cup-lead's
 *  injected `exec`. */
export async function cupExec(base, session, command, fetchImpl = fetch) {
  const res = await postLickback(base, '/api/shell/exec', session, { command }, fetchImpl);
  if (!res.ok) return '';
  try {
    const body = await res.json();
    return typeof body?.stdout === 'string' ? body.stdout : '';
  } catch {
    return '';
  }
}

/** Dev vs prod launch mode from the repo clone's current git branch. A feature-branch
 *  clone (HEAD is not `main`, not detached) runs UNMERGED code that production
 *  www.sliccy.ai doesn't have yet, so the cup must load the LOCAL build (wrangler :8787 +
 *  `cup-dev`) → 'dev'. On `main` (deployed), a detached HEAD, or outside a git clone →
 *  'prod' (`npm run cup`, Chrome dials the hosted origin). */
export function cupLaunchMode(branch) {
  return branch && branch !== 'main' && branch !== 'HEAD' ? 'dev' : 'prod';
}

/** Local wrangler dev origin used in dev mode (SLICC_WRANGLER_URL overrides). */
export const DEFAULT_WRANGLER_URL = 'http://localhost:8787';
export function wranglerUrl() {
  return process.env.SLICC_WRANGLER_URL || DEFAULT_WRANGLER_URL;
}
/** Repo root for the git-branch heuristic (SLICC_REPO_DIR overrides cwd). */
export function cupRepoDir() {
  return process.env.SLICC_REPO_DIR || process.cwd();
}
/** Single dev|prod resolution shared by cup-up + cup-lead: an explicit
 *  SLICC_CUP_MODE wins, else the git-branch heuristic ({@link cupLaunchMode} over
 *  {@link gitBranch}). Centralized so the heuristic lives in ONE place. */
export function resolveCupMode(repoDir = cupRepoDir()) {
  const forced = process.env.SLICC_CUP_MODE;
  if (forced === 'dev' || forced === 'prod') return forced;
  return cupLaunchMode(gitBranch(repoDir));
}

/** Ensure a cup is reachable. `resolveBase()` is re-read each poll because the
 *  launched cup may bind a DIFFERENT port than the pre-launch guess (5710 busy →
 *  OS-assigned ephemeral port, recorded in cup.json). If `probe(base)` is already
 *  truthy, resolve { base, launched:false } without launching. Otherwise call
 *  `launch()` once and poll up to `attempts` times, resolving { base,
 *  launched:true } once it's up — or throw after the budget. `resolveBase` /
 *  `probe` / `launch` / `sleep` are injected so all branching is unit-testable
 *  without spawning a real cup. */
export async function ensureCupReady({
  resolveBase,
  probe,
  launch,
  sleep,
  attempts = 60,
  intervalMs = 1000,
}) {
  let base = resolveBase();
  if (await probe(base)) return { base, launched: false };
  await launch();
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    base = resolveBase(); // follow the port the launched cup actually advertised
    if (await probe(base)) return { base, launched: true };
  }
  throw new Error(`cup did not become ready after ${attempts} probes`);
}

/** Filename a running drain advertises itself under, in `drainsDir()`. */
export function drainPidfileName(port, pid) {
  return `${port}-${pid}`;
}

/** Inverse of {@link drainPidfileName}; null for anything that isn't `<port>-<pid>`
 *  with a valid port (1..65535) and a positive pid. */
export function parseDrainPidfileName(name) {
  const parts = name.split('-');
  if (parts.length !== 2) return null;
  const port = Number(parts[0]);
  const pid = Number(parts[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { port, pid };
}

/** Reap any stale lick-back drains for `port` before a new brain claims the channel —
 *  the orphaned drain from a prior session is what pins the claim open. PORT-SCOPED, so a
 *  parallel cup's drain on another port is left alone; and pid-reuse-safe, so `isReapable`
 *  must confirm the pid is alive AND actually a lickback-drain before we signal it. Every
 *  matching-port pidfile is removed (a dead/stale file too); only reapable pids are killed.
 *  Pure: inject listEntries/isReapable/kill/remove so it's testable without real processes. */
export function reapStaleDrains({ port, listEntries, isReapable, kill, remove }) {
  const killed = [];
  const removed = [];
  for (const name of listEntries()) {
    const parsed = parseDrainPidfileName(name);
    if (!parsed || parsed.port !== port) continue;
    if (isReapable(parsed.pid)) {
      kill(parsed.pid);
      killed.push(parsed.pid);
    }
    remove(name);
    removed.push(name);
  }
  return { killed, removed };
}

/** Attempt a claim, retrying on 409 to ride out the ~lease-length tail a just-reaped
 *  drain leaves behind (the cup keeps the dead session as owner until the lease lapses).
 *  First attempt is immediate; sleeps only BETWEEN attempts; never retries a hard error
 *  (non-200/409). Returns the final `{ status, owner }`. Pure: inject attemptClaim/sleep. */
export async function claimWithRetry({ attemptClaim, sleep, attempts = 31, intervalMs = 2000 }) {
  let result = await attemptClaim();
  for (let i = 1; i < attempts && result.status === 409; i++) {
    await sleep(intervalMs);
    result = await attemptClaim();
  }
  return result;
}

/** Stop a process by escalating signals (cup-stop): SIGTERM, then poll `isAlive`
 *  up to `attempts` times (`intervalMs` apart) for a graceful exit, then SIGKILL
 *  if it's still alive. A pid that's already gone is a no-op. Returns
 *  `{ signaled, escalated }` — `signaled` false iff the pid was already dead,
 *  `escalated` true iff a SIGKILL was needed. Pure: inject isAlive/kill/sleep so
 *  the escalation logic is unit-testable without real processes. */
export async function stopByPid({ pid, isAlive, kill, sleep, attempts = 15, intervalMs = 200 }) {
  if (!isAlive(pid)) return { signaled: false, escalated: false, confirmed: true };
  kill(pid, 'SIGTERM');
  for (let i = 0; i < attempts; i++) {
    if (!isAlive(pid)) return { signaled: true, escalated: false, confirmed: true };
    await sleep(intervalMs);
  }
  if (!isAlive(pid)) return { signaled: true, escalated: false, confirmed: true };
  kill(pid, 'SIGKILL');
  // SIGKILL is uncatchable, but a process wedged in uninterruptible (D-state)
  // sleep can briefly outlive the signal call. Confirm death so the caller doesn't
  // clear the discovery file out from under a cup that's still running (which would
  // let the next cup-up launch a SECOND instance).
  return { signaled: true, escalated: true, confirmed: !isAlive(pid) };
}

/** Drain reconnect accounting (F6). A stream attempt that CONNECTED (reached the
 *  read loop) resets the failure budget even if it later dropped mid-stream — the
 *  lick-back SSE endpoint never ends cleanly, so every long-lived drop surfaces as
 *  a mid-read throw; counting those as failures let a healthy drain's ~Nth
 *  reconnect trip MAX_FAILS and die. Only a pre-stream connect failure ('refused')
 *  increments. `outcome` is the {@link streamOnce} verdict; 'lost' is handled
 *  (exit 3) before this is consulted. Pure for unit testing. */
export function nextFailCount(outcome, fails) {
  return outcome === 'connected' ? 0 : fails + 1;
}

export async function postLickback(
  base,
  path,
  session,
  body,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  return fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Slicc-Session': session },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — run cup-discover and pass it on every call.`);
  return v;
}

export function positionals(argv) {
  return argv.filter((a) => !a.startsWith('-'));
}
export function pickChannel(argv, fallback = DEFAULT_CHANNEL) {
  return positionals(argv)[0] || fallback;
}

/** Parse `--wait N` out of argv; the lone positional is the channel. */
export function parseNextArgs(argv) {
  let wait = 30;
  let channel = DEFAULT_CHANNEL;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wait') {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(n)) wait = n;
    } else if (!argv[i].startsWith('-')) {
      rest.push(argv[i]);
    }
  }
  if (rest[0]) channel = rest[0];
  return { wait, channel };
}

/** 200 -> own (0); 409 -> owned by another (3); anything else -> error (1). */
export function exitForOwnership(status) {
  if (status === 200) return 0;
  if (status === 409) return 3;
  return 1;
}

/** ONE atomic frame carrying the whole answer plus its `done:true` terminator
 *  (F8). A single POST means delivery is all-or-nothing: the panel either renders
 *  the turn and releases its working spinner, or — if the POST fails — renders
 *  nothing at all. The old delta-then-done pair could land the text then fail the
 *  separate terminator, hanging the spinner on a half-delivered turn. `text` is
 *  omitted for an empty / decline answer so the lone frame is a bare terminator. */
export function buildReplyFrames(replyTo, channel, text) {
  return [{ channel, replyTo, ...(text ? { text } : {}), done: true }];
}

/** Fully-written lines only — a trailing partial (drain mid-append) is excluded. */
export function splitCompleteLines(content) {
  if (!content) return [];
  const parts = content.split('\n');
  parts.pop(); // trailing '' (clean) or partial (mid-write) — drop either way
  return parts.filter((l) => l.length > 0);
}

export function nextLine(content, cursor) {
  const lines = splitCompleteLines(content);
  if (cursor >= lines.length) return { line: null, nextCursor: cursor };
  return { line: lines[cursor], nextCursor: cursor + 1 };
}

/** Joined `data:` payload of one SSE event block, or null. */
export function parseSseData(block) {
  const datas = block
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''));
  return datas.length ? datas.join('\n') : null;
}

/** True when this module is the process entry point (not imported by a test). */
export function isDirectRun(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return metaUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}
