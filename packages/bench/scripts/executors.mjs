import { spawn } from 'node:child_process';
import {
  CONNECT_RETRIES,
  CONNECT_RETRY_DELAY_MS,
  isConnectFailure,
} from '../../github-workflow/scripts/gh-io.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KILL_GRACE_MS = 10_000;

export function runProcess(cli, args, { stdin, timeoutMs, interrupt = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1' },
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

    child.on('exit', (code, signal) => {
      if (timedOut) finish(code, signal);
    });
    child.on('close', finish);
    child.stdin.end(stdin ?? '');
  });
}

export function createLeader({
  url,
  cli = process.env.SLICC_CLI || 'slicc',
  run = runProcess,
  retryDelayMs = CONNECT_RETRY_DELAY_MS,
} = {}) {
  if (!url) throw new Error('driving the leader needs its join URL (SLICC_JOIN_URL)');
  async function call(args, opts = {}) {
    for (let attempt = 1; ; attempt += 1) {
      const result = await run(cli, [url, ...args], opts);
      if (isConnectFailure(result.status, result.stderr) && attempt < CONNECT_RETRIES) {
        await sleep(retryDelayMs);
        continue;
      }
      return result;
    }
  }
  return {
    cli: call,
    exec: (command, opts) => call(['exec', command], opts),
  };
}
