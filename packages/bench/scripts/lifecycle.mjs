import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../../github-workflow/scripts/gh-io.mjs';

export const RESTART_TIMEOUT_MS = 10 * 60_000;

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

export function currentLeader(read = readState) {
  const state = read();
  if (!state?.joinUrl) return null;

  const started = state.startedAt;
  return {
    url: state.joinUrl,
    startedAt: typeof started === 'number' ? new Date(started).toISOString() : (started ?? null),
    sliccVersion: state.sliccVersion ?? null,
  };
}

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

    const scriptEnv = { ...env, GITHUB_OUTPUT: join(scratch, 'output') };
    try {
      const stop = await run(join(scriptsDir, 'stop-leader.mjs'), { env: scriptEnv });
      if (stop.status !== 0)
        throw new Error(`stop-leader exited ${stop.status}: ${stop.output.slice(-400)}`);
      if (profileDir) rmSync(profileDir, { recursive: true, force: true });
      const start = await run(join(scriptsDir, 'start-leader.mjs'), { env: scriptEnv });
      if (start.status !== 0)
        throw new Error(`start-leader exited ${start.status}: ${start.output.slice(-400)}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const leader = currentLeader(read);
    if (!leader) throw new Error('start-leader finished without a join URL in its state file');
    mask(leader.url);
    return leader;
  };
}

export function redact(text, urls = []) {
  let out = String(text ?? '');
  for (const u of urls) if (u) out = out.split(u).join('<join-url>');
  return out.replace(/\/(join|controller|webhook)\/[^\s/"'?#]+/g, '/$1/<token>');
}

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
    event(type, data = {}) {
      const at = new Date(now()).toISOString();
      append('events.jsonl', { at, type, ...data });

      const target = typeof leaderLog === 'function' ? leaderLog(data) : leaderLog;
      if (!target) return;
      try {
        appendFileSync(
          target,
          `[bench-event] ${at} ${type}${data.task_id ? ` ${data.task_id}` : ''}\n`
        );
      } catch {}
    },
  };
}

export function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

export function laneEnv(i, env = process.env) {
  const base = env.SLICC_GW_HOME || join(env.RUNNER_TEMP || tmpdir(), 'slicc-gw');
  const port = (Number.parseInt(env.BENCH_LEADER_BASE_PORT, 10) || 5710) + i;
  return { SLICC_GW_HOME: `${base}-lane${i}`, INPUT_PORT: String(port) };
}

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
