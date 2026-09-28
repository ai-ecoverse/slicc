import { spawn, spawnSync } from 'node:child_process';
import {
  CONNECT_RETRIES,
  CONNECT_RETRY_DELAY_MS,
  isConnectFailure,
} from '../../github-workflow/scripts/gh-io.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TERMINAL_TIMEOUT_RE = /terminal-open timed out/i;

export function unreachable(status, stderr) {
  return (
    isConnectFailure(status, stderr) || (status !== 0 && TERMINAL_TIMEOUT_RE.test(String(stderr)))
  );
}

const CONNECTION_LOST_RE =
  /read\/write on closed pipe|connection closed|the leader sent no model list within/i;

export function connectionLost(status, stderr) {
  return status !== 0 && CONNECTION_LOST_RE.test(String(stderr));
}

export const KILL_GRACE_MS = 20_000;

export const DEFAULT_CALL_TIMEOUT_MS = 180_000;

export function runProcess(cli, args, { stdin, timeoutMs, interrupt = false, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    const timers = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        status: code ?? (sig ? 128 + (sig === 'SIGINT' ? 2 : 15) : 1),
        timedOut,
        ...(aborted ? { aborted: true } : {}),
      });
    };

    function onAbort() {
      if (settled) return;
      aborted = true;
      child.kill(interrupt ? 'SIGINT' : 'SIGTERM');
      timers.push(setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS));
    }
    if (signal?.aborted) queueMicrotask(onAbort);
    else signal?.addEventListener('abort', onAbort, { once: true });
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

    child.on('exit', (code, sig) => {
      if (timedOut || aborted) finish(code, sig);
    });
    child.on('close', finish);

    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}

export function callLabel(args) {
  if (args[0] !== 'exec') return args.join(' ').slice(0, 80);
  return `exec ${
    String(args[1] ?? '')
      .trim()
      .split(/\s+/)[0]
  }`;
}

export const REQUIRED_CLI_OPTIONS = [
  'prompt [--allsettled',
  'wait --allsettled',
  '<join-url> abort',
];

const checkedClis = new Set();

export function assertCliSupports(cli, options = REQUIRED_CLI_OPTIONS, run = spawnSync) {
  if (checkedClis.has(cli)) return;
  const help = run(cli, ['--help'], { encoding: 'utf8', timeout: 30_000 });
  const text = `${help.stdout ?? ''}${help.stderr ?? ''}`;
  const missing = options.filter((o) => !text.includes(o));
  if (help.error || missing.length) {
    throw new Error(
      `${cli} does not support ${missing.join(', ') || options.join(', ')}; build the CLI from this checkout (packages/slicc-cli)`
    );
  }
  checkedClis.add(cli);
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
  if (run === runProcess) assertCliSupports(cli);
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
      const lost = !dialFailed && connectionLost(result.status, result.stderr);
      const leaderDown = dialFailed || lost;
      const out = { ...result, leaderDown, ...(lost ? { connectionLost: true } : {}) };
      onCall({
        at: new Date(started).toISOString(),
        call: callLabel(args),
        ms: now() - started,
        status: result.status,
        timedOut: Boolean(result.timedOut),
        attempts: attempt,
        leaderDown,
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
