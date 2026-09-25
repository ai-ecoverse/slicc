/**
 * The leader, driven from outside through the Go `slicc` follower CLI — the same path a person
 * or packages/github-workflow uses. Nothing runs on the leader but its own shell commands and
 * its own cone.
 *
 * `createLeader({ url })` returns:
 * - `cli(args, { stdin, timeoutMs, interrupt })` → `{ stdout, stderr, status, timedOut,
 *   leaderDown }` for any verb (`prompt`, `new-session`, `model`, `exec`, …). Never throws on a
 *   non-zero status.
 * - `exec(command, opts)`: `cli(['exec', command], opts)`.
 * - `url` / `setUrl(url)`: the join URL, replaced when the leader is recycled.
 *
 * A dial failure (nothing reached the leader) is retried, and the retries run with
 * `SLICC_DEBUG=1` so the CLI's signaling and ICE diagnostics are kept (`onCall`'s `diagnostics`).
 * When every attempt fails to dial, the result has `leaderDown: true`. An execution is never
 * retried. Every call gets a timeout (`defaultTimeoutMs` unless given), so a hung connection
 * cannot stall a run. A timeout sends SIGINT when `interrupt` is set: `slicc prompt` answers
 * SIGINT by sending the leader an `abort`, so a stopped task does not go on spending tokens.
 */

import { spawn } from 'node:child_process';
import {
  CONNECT_RETRIES,
  CONNECT_RETRY_DELAY_MS,
  isConnectFailure,
} from '../../github-workflow/scripts/gh-io.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The leader was reached but did not open a terminal in time: an overloaded or wedged leader.
 * The command never ran, so it is safe to retry, and it counts as the leader being down.
 */
const TERMINAL_TIMEOUT_RE = /terminal-open timed out/i;

/** A call that never ran on the leader: no connection, or no terminal. */
export function unreachable(status, stderr) {
  return (
    isConnectFailure(status, stderr) || (status !== 0 && TERMINAL_TIMEOUT_RE.test(String(stderr)))
  );
}

/** Grace between the timeout signal and SIGKILL, for the CLI to deliver its `abort`. */
const KILL_GRACE_MS = 10_000;

/** Bound on any call that does not bring its own (a prompt does): generous, never infinite. */
export const DEFAULT_CALL_TIMEOUT_MS = 180_000;

export function runProcess(cli, args, { stdin, timeoutMs, interrupt = false, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    const timers = [];
    let timedOut = false;
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        status: code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 1),
        timedOut,
      });
    };
    if (timeoutMs) {
      timers.push(
        setTimeout(() => {
          timedOut = true;
          child.kill(interrupt ? 'SIGINT' : 'SIGTERM');
          timers.push(setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS));
        }, timeoutMs)
      );
    }
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', reject);
    // After a timeout, a grandchild can keep the pipes open: settle on exit, not close.
    child.on('exit', (code, signal) => {
      if (timedOut) finish(code, signal);
    });
    child.on('close', finish);
    // A CLI that exits without reading its stdin (a failed dial) must not crash the runner.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}

/** A short, secret-free name for a call: the verb, and for exec the command's first word. */
export function callLabel(args) {
  if (args[0] !== 'exec') return args.join(' ').slice(0, 80);
  return `exec ${
    String(args[1] ?? '')
      .trim()
      .split(/\s+/)[0]
  }`;
}

export function createLeader({
  url,
  cli = process.env.SLICC_CLI || 'slicc',
  run = runProcess,
  retryDelayMs = CONNECT_RETRY_DELAY_MS,
  defaultTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  onCall = () => {},
  now = Date.now,
} = {}) {
  if (!url) throw new Error('driving the leader needs its join URL (SLICC_JOIN_URL)');
  let joinUrl = url;
  async function call(args, opts = {}) {
    const options = { ...opts, timeoutMs: opts.timeoutMs ?? defaultTimeoutMs };
    const diagnostics = [];
    const started = now();
    for (let attempt = 1; ; attempt += 1) {
      const retrying = attempt > 1;
      const result = await run(cli, [joinUrl, ...args], {
        ...options,
        ...(retrying ? { env: { ...options.env, SLICC_DEBUG: '1' } } : {}),
      });
      const dialFailed = unreachable(result.status, result.stderr);
      if (dialFailed && retrying) diagnostics.push(result.stderr);
      if (dialFailed && attempt < CONNECT_RETRIES) {
        await sleep(retryDelayMs);
        continue;
      }
      const out = { ...result, leaderDown: dialFailed };
      onCall({
        at: new Date(started).toISOString(),
        call: callLabel(args),
        ms: now() - started,
        status: result.status,
        timedOut: Boolean(result.timedOut),
        attempts: attempt,
        leaderDown: dialFailed,
        ...(result.status !== 0 ? { stderr: String(result.stderr).slice(-400) } : {}),
        ...(diagnostics.length ? { diagnostics } : {}),
      });
      return out;
    }
  }
  return {
    get url() {
      return joinUrl;
    },
    setUrl(next) {
      if (!next) throw new Error('a recycled leader needs a join URL');
      joinUrl = next;
    },
    cli: call,
    exec: (command, opts) => call(['exec', command], opts),
  };
}
