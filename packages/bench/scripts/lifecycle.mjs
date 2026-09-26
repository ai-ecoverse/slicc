/**
 * The leader's lifecycle in CI: which leader runs now, how old it is, and restarting it. A
 * restart runs the scripts behind the start-leader and stop-leader actions, so a recycled leader
 * boots exactly like the job's first one. The start inputs come from the environment as that
 * action passes them (`INPUT_*`, set on the bench step), and the new join URL is read from the
 * leader state file the scripts share.
 *
 * `createRecycler({ scriptsDir })` returns `recycle()` → `{ url, startedAt, sliccVersion }`.
 * Without `BENCH_LEADER_SCRIPTS`, a leader cannot be restarted (a local harness), and
 * `currentLeader()` is null.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../../github-workflow/scripts/gh-io.mjs';

/** A boot is an npm install plus Chrome plus a tray: minutes at most. */
export const RESTART_TIMEOUT_MS = 10 * 60_000;

/** Run a Node script, keeping the tail of its output. Resolves `{ status, output }`. */
export function runNode(script, { env, timeoutMs = RESTART_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const keep = (b) => {
      chunks.push(b);
      if (chunks.length > 200) chunks.shift();
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? 1, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/** The running leader as the state file describes it, or null when there is none. */
export function currentLeader(read = readState) {
  const state = read();
  if (!state?.joinUrl) return null;
  // start-leader records `startedAt` as epoch milliseconds.
  const started = state.startedAt;
  return {
    url: state.joinUrl,
    startedAt: typeof started === 'number' ? new Date(started).toISOString() : (started ?? null),
    sliccVersion: state.sliccVersion ?? null,
  };
}

/**
 * Stop the current leader and boot a fresh one. `mask` hides the new join URL in the job log,
 * as start-leader does for the first. Throws when the new leader does not come up.
 *
 * Fresh means fresh: start-leader reuses `<home>/profile` as Chrome's user-data dir, and the
 * webapp keeps its VFS, sessions and scoops there. A restart that keeps the profile boots the old
 * leader's scoops with it: in the first full BU V1 run they carried over from task to task and
 * across restarts, kept working, and billed later tasks. So the old profile is wiped between
 * stop and start.
 */
export function createRecycler({
  scriptsDir,
  env = process.env,
  run = runNode,
  read = readState,
  mask = (url) => {
    if (env.GITHUB_ACTIONS) console.log(`::add-mask::${url}`);
  },
}) {
  return async function recycle() {
    const profileDir = read()?.profileDir ?? null;
    const scratch = mkdtempSync(join(tmpdir(), 'bench-leader-'));
    // The scripts append outputs for their action; keep a restart's out of this step's.
    const scriptEnv = { ...env, GITHUB_OUTPUT: join(scratch, 'output') };
    try {
      const stop = await run(join(scriptsDir, 'stop-leader.mjs'), { env: scriptEnv });
      if (stop.status !== 0)
        throw new Error(`stop-leader exited ${stop.status}: ${stop.output.slice(-400)}`);
      if (profileDir) rmSync(profileDir, { recursive: true, force: true });
      const start = await run(join(scriptsDir, 'start-leader.mjs'), { env: scriptEnv });
      if (start.status !== 0) {
        const err = new Error(`start-leader exited ${start.status}: ${start.output.slice(-400)}`);
        // All of it, for diagnostics/: the tail alone is Chrome noise more often than not.
        err.output = start.output;
        throw err;
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const leader = currentLeader(read);
    if (!leader) throw new Error('start-leader finished without a join URL in its state file');
    mask(leader.url);
    return leader;
  };
}

/** Join tokens and URLs out of diagnostic text, which lands in artifacts. */
export function redact(text, urls = []) {
  let out = String(text ?? '');
  for (const u of urls) if (u) out = out.split(u).join('<join-url>');
  return out.replace(/\/(join|controller|webhook)\/[^\s/"'?#]+/g, '/$1/<token>');
}

/**
 * The run's diagnostic journal, beside its records: `calls.jsonl` (every leader call: what,
 * when, how long, how it ended), `events.jsonl` (task results with leader age and health,
 * restarts, stops), and `diagnostics/` (the CLI's debug output for failed dials, the output of
 * failed leader boots). Everything
 * is redacted of join URLs; nothing holds task text. With `leaderLog`, each event also appends a
 * `[bench-event]` line to the leader's own log (same runner), so its lines read as a timeline.
 */
export function createJournal(dir, { urls = () => [], now = Date.now, leaderLog = null } = {}) {
  mkdirSync(join(dir, 'diagnostics'), { recursive: true });
  let dials = 0;
  const append = (file, value) => appendFileSync(join(dir, file), `${JSON.stringify(value)}\n`);
  return {
    call(entry) {
      const e = { ...entry };
      if (e.stderr) e.stderr = redact(e.stderr, urls());
      if (e.diagnostics) {
        dials += 1;
        const file = `diagnostics/${String(dials).padStart(3, '0')}-${e.call.replace(/[^A-Za-z0-9]+/g, '-')}.log`;
        writeFileSync(
          join(dir, file),
          redact(e.diagnostics.join('\n--- next attempt ---\n'), urls())
        );
        e.diagnostics = file;
      }
      append('calls.jsonl', e);
    },
    /** Keep a long diagnostic text (redacted) under diagnostics/; returns its path. */
    diagnostic(name, text) {
      const file = `diagnostics/${name.replace(/[^A-Za-z0-9-]+/g, '-')}.log`;
      writeFileSync(join(dir, file), redact(text, urls()));
      return file;
    },
    event(type, data = {}) {
      const at = new Date(now()).toISOString();
      append('events.jsonl', { at, type, ...data });
      // One leader log, or one per lane (a function of the event).
      const target = typeof leaderLog === 'function' ? leaderLog(data) : leaderLog;
      if (!target) return;
      try {
        appendFileSync(
          target,
          `[bench-event] ${at} ${type}${data.task_id ? ` ${data.task_id}` : ''}\n`
        );
      } catch {
        // The leader log is a diagnostic aid; the run goes on without it.
      }
    },
  };
}

/**
 * One at a time: every leader boot and stop on this runner goes through the same lock. The
 * leaders share `/slicc/cone-config.json`, which start-leader writes and stop-leader deletes, so a
 * lane stopping while another boots could leave that one without its provider configuration.
 */
export function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

/** A lane's own leader home and port, so the leaders on one runner do not collide. */
export function laneEnv(i, env = process.env) {
  const base = env.SLICC_GW_HOME || join(env.RUNNER_TEMP || tmpdir(), 'slicc-gw');
  const port = (Number.parseInt(env.BENCH_LEADER_BASE_PORT, 10) || 5710) + i;
  return { SLICC_GW_HOME: `${base}-lane${i}`, INPUT_PORT: String(port) };
}

/** Stop the leader a lane env points at, with the stop-leader script. */
export async function stopLeader({ scriptsDir, env, run = runNode }) {
  const scratch = mkdtempSync(join(tmpdir(), 'bench-leader-'));
  try {
    const r = await run(join(scriptsDir, 'stop-leader.mjs'), {
      env: { ...env, GITHUB_OUTPUT: join(scratch, 'output') },
    });
    if (r.status !== 0) throw new Error(`stop-leader exited ${r.status}: ${r.output.slice(-400)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Boot lane `i`'s leader in its own home and port, and return what the runner drives it with:
 * `{ leader, recycle, stop, startedAt, sliccVersion, leaderLog }`. Boots, restarts and the final
 * stop all go through `lock`.
 */
export async function bootLane(
  i,
  {
    scriptsDir,
    env = process.env,
    run = runNode,
    read,
    lock = createLock(),
    claims = new Map(),
    makeLeader,
    onCall,
  }
) {
  const laneVars = { ...env, ...laneEnv(i, env) };
  const home = laneVars.SLICC_GW_HOME;
  const readLane = read ?? (() => readState(home));
  const recycleOnce = createRecycler({ scriptsDir, env: laneVars, run, read: readLane });
  // Every node-server writes its join URL to the same /tmp/slicc-join.json, so a leader that
  // re-posts its status while this lane boots can hand this lane its URL. Two lanes on one
  // leader would share a cone: restart until the URL is this lane's own.
  const recycle = () =>
    lock(async () => {
      for (let attempt = 1; ; attempt += 1) {
        const info = await recycleOnce();
        const holder = [...claims].find(([lane, url]) => lane !== i && url === info.url)?.[0];
        if (holder === undefined) {
          claims.set(i, info.url);
          return info;
        }
        if (attempt >= 2) throw new Error(`lane ${i} was handed lane ${holder}'s join URL twice`);
      }
    });
  const info = await recycle();
  return {
    leader: makeLeader({ url: info.url, onCall: (e) => onCall?.({ ...e, lane: i }) }),
    recycle,
    stop: () =>
      lock(async () => {
        claims.delete(i);
        await stopLeader({ scriptsDir, env: laneVars, run });
      }),
    startedAt: info.startedAt,
    sliccVersion: info.sliccVersion,
    leaderLog: join(home, 'leader.log'),
  };
}
