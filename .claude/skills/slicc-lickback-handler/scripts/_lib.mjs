// Shared helpers for the slicc-lickback-handler operator scripts. Pure logic is
// exported and unit-tested; the two fetch helpers are integration-tested against
// a node:http fake cup. Each script is a thin wrapper over this module, so all
// branching logic lives here where it can be tested without spawning.
// tva
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

/** A single delta carrying the whole text, then a done terminator. The done
 *  frame is ALWAYS emitted so a forgotten terminator is impossible. */
export function buildReplyFrames(replyTo, channel, text) {
  const frames = [];
  if (text) frames.push({ channel, replyTo, delta: text });
  frames.push({ channel, replyTo, done: true });
  return frames;
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
