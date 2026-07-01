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

// --- cup-clean: orphan classification (the SAFETY core) ------------------------

/** Markers that identify a Claude Code SESSION — NEVER a cup orphan. Checked first
 *  so the sweep can never kill the operator's brain or this very session. */
const CLAUDE_SESSION_RE =
  /--dangerously-skip-permissions|--session-id\b|bg-pty-host|ClaudeCode\.app|native-binary\/claude/;

/** True iff `dir` appears in `command` as a true PATH PREFIX — immediately followed by
 *  a path separator, whitespace, quote, or end of string — so a sibling clone whose path
 *  merely string-prefixes `dir` (e.g. `<dir>-playground`) does NOT match. A bare
 *  `command.includes(dir)` would let cup-clean SIGKILL a parallel clone's workerd, breaking
 *  the "a parallel clone's processes are untouched" contract. Pure. */
function commandPathUnderDir(command, dir) {
  if (!dir) return false;
  for (let idx = command.indexOf(dir); idx !== -1; idx = command.indexOf(dir, idx + 1)) {
    const next = command[idx + dir.length];
    if (
      next === undefined ||
      next === '/' ||
      next === ' ' ||
      next === '\t' ||
      next === '\n' ||
      next === '"' ||
      next === "'"
    ) {
      return true;
    }
  }
  return false;
}

/** Classify a process command line as a cup-related orphan, or null. This is the
 *  blast-radius gate for `cup-clean`: it matches ONLY cup infrastructure by a
 *  distinctive marker, and NEVER an everyday Chrome (default profile), a `claude`
 *  session, or an unrelated wrangler. `repoDir` scopes repo-specific runtimes
 *  (workerd) so a parallel clone's processes are untouched. Pure. Categories:
 *  'cup-node' | 'lickback-script' | 'wrangler' | 'wrangler-runtime' | 'cup-chrome'. */
export function classifyCupProcess(command, repoDir = '') {
  const c = command || '';
  if (CLAUDE_SESSION_RE.test(c)) return null;
  // The cup node-server: the `--cup` flag on the node-server entry.
  if (/(?:^|\s)--cup(?:\s|$)/.test(c) && /(?:index\.ts|node-server)/.test(c)) return 'cup-node';
  // A long-running lick-back handler script (the orphan-prone ones).
  if (/scripts\/(?:lickback-wait|lickback-drain|lickback-next)\.mjs/.test(c))
    return 'lickback-script';
  // The cup-dev wrangler (only one ever binds :8787; scoped by the slicc worker config).
  if (/\bwrangler\b/.test(c) && /cloudflare-worker\/wrangler\.jsonc/.test(c)) return 'wrangler';
  // The workerd that wrangler spawned — only when it lives under THIS repo dir (a true
  // path prefix, not a bare substring, so a sibling `<repoDir>-*` clone is untouched).
  if (/\bworkerd\b/.test(c) && repoDir.length > 0 && commandPathUnderDir(c, repoDir))
    return 'wrangler-runtime';
  // The cup's Chrome — keyed on the cup-distinctive `cup=1` launch-URL param
  // (appendCupParam in launch-url.ts), NOT the profile name. The profile name
  // `browser-coding-agent-chrome[-<port>]` is NOT cup-distinctive: the DEFAULT-port cup
  // uses it with no suffix, AND a non-cup `npm run dev` standalone uses the identical
  // name — so keying on it both MISSES the default-port cup and would FALSELY kill a
  // dev Chrome. `cup=1` is present only on the cup's main Chrome process (launched with
  // the cup URL), never on a renderer helper or a non-cup standalone.
  if (/[?&]cup=1\b/.test(c)) return 'cup-chrome';
  return null;
}

/** Extract the SLICC cup-Chrome profile dir from a `--user-data-dir=<path>` arg, or
 *  null. Anchored to the `browser-coding-agent-chrome[-<port>]` profile component so it
 *  works even though the macOS path contains a space ("Application Support") that a
 *  naive `\S+` capture would truncate. cup-clean's `--profiles` uses this to remove ONLY
 *  the profile of a cup Chrome it ALREADY identified (via cup=1) — never an arbitrary
 *  dir, and never a non-cup standalone's. Pure. */
export function cupProfileDirFromCommand(command) {
  const m = (command || '').match(
    /--user-data-dir=(.*\/browser-coding-agent-chrome(?:-\d+)?)(?=\s|$)/
  );
  return m ? m[1] : null;
}

/** Given the cup-Chrome orphans (each `{ profileDir, stopped }`), return the profile dirs
 *  `--profiles` may delete: only those of a Chrome we ACTUALLY stopped (or, in a dry run,
 *  all captured ones, since nothing is removed). A Chrome that survived SIGKILL is still
 *  running, so deleting its profile would wipe a LIVE profile (lost logins / corruption) —
 *  skip it. Null/missing dirs are dropped. Pure. */
export function selectCupProfileDeletions(chromeOrphans, { dryRun = false } = {}) {
  return (chromeOrphans ?? [])
    .filter((o) => o?.profileDir && (dryRun || o.stopped))
    .map((o) => o.profileDir);
}

/** Parse cup-clean's argv into an explicit mode — the footgun guard so a `--help`
 *  or a typo'd flag can NEVER fall through to the destructive run. `--help`/`-h`
 *  → {mode:'help'} (always wins). Any unrecognized flag → {mode:'error', unknown}.
 *  Otherwise {mode:'run', dryRun, doProfiles}. Pure. */
export function parseCleanArgs(argv) {
  const args = argv ?? [];
  if (args.includes('--help') || args.includes('-h')) return { mode: 'help' };
  const known = new Set(['--dry-run', '--profiles']);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length > 0) return { mode: 'error', unknown };
  return {
    mode: 'run',
    dryRun: args.includes('--dry-run'),
    doProfiles: args.includes('--profiles'),
  };
}

/** Parse `ps -Ao pid=,command=` output into `{ pid, command }[]`, dropping junk lines. */
export function parsePsEntries(psOutput) {
  return (psOutput || '')
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*(\d+)\s+(.*\S)\s*$/);
      return m ? { pid: Number(m[1]), command: m[2] } : null;
    })
    .filter((e) => e !== null);
}

/** From parsed ps entries, pick the cup orphans (via {@link classifyCupProcess}),
 *  excluding `selfPids` (cup-clean's own pid + parent, so it never kills its own
 *  shell). Pure. */
export function selectCupOrphans(psEntries, { repoDir = '', selfPids = [] } = {}) {
  const self = new Set(selfPids.map(Number).filter(Number.isInteger));
  const out = [];
  for (const e of psEntries) {
    const pid = Number(e.pid);
    if (!Number.isInteger(pid) || self.has(pid)) continue;
    const category = classifyCupProcess(e.command, repoDir);
    if (category) out.push({ pid, category, command: e.command });
  }
  return out;
}

/** Plan which cup state files to remove: the lick-back buffers/drain pidfiles are
 *  always stale-safe; cup.json is removed ONLY when no live cup still owns it (so a
 *  surviving cup's discovery file isn't cleared out from under it). Pure. */
export function planStateCleanup({ cupJsonPath, cupAlive, lickbackFiles = [] }) {
  const files = [...lickbackFiles];
  if (cupJsonPath && !cupAlive) files.push(cupJsonPath);
  return files;
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

/** Split a buffer into complete SSE event blocks (delimited by a blank line,
 *  `\n\n`), returning the parsed `blocks` and the trailing partial `rest` that has
 *  not yet been terminated. Pure — the long-poll read loop feeds it each decoded
 *  chunk and carries `rest` forward. */
export function takeSseBlocks(buf) {
  const blocks = [];
  let rest = buf;
  let idx;
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    blocks.push(rest.slice(0, idx));
    rest = rest.slice(idx + 2);
  }
  return { blocks, rest };
}

/** Joined `data:` payload of one SSE event block, or null. */
export function parseSseData(block) {
  const datas = block
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''));
  return datas.length ? datas.join('\n') : null;
}

/** True iff an SSE event block carries an `event: lickback-control` field line —
 *  the cup's operator stand-down signal (registry.stop). This is structurally
 *  unforgeable by a browser-pushed event, which is ALWAYS written as a `data:`
 *  line and so can never emit an `event:` field, even if its payload text mentions
 *  `lickback-control`. Checked before {@link parseSseData} so a control frame
 *  exits the wait (code 4) instead of being mis-read as a chat message. */
export function isStopControl(block) {
  return block
    .split('\n')
    .filter((l) => l.startsWith('event:'))
    .map((l) => l.slice(6).replace(/^ /, '').trim())
    .some((v) => v === 'lickback-control');
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
