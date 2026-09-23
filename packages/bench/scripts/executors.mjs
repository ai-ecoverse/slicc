/**
 * Ways to run a shell command on a SLICC leader. Every executor has the same shape:
 * `exec(command, { stdin?, timeoutMs? }) → Promise<{ stdout, stderr, status }>`, never throwing
 * on a non-zero status (the caller decides), throwing only when the leader is unreachable.
 *
 * - `createCliExec`: the Go `slicc` follower CLI against a join URL — what CI uses, the same
 *   path as packages/github-workflow's actions. Dial failures are retried; executions never are.
 * - `createCdpExec`: a local dev harness (packages/dev-tools/tools/dev-standalone-fresh.sh) over
 *   Chrome DevTools, through the sprinkle bridge's exec session, which is independent of the
 *   terminal panel. Node >= 22's global WebSocket, no dependency.
 */

import { spawn } from 'node:child_process';
import {
  CONNECT_RETRIES,
  CONNECT_RETRY_DELAY_MS,
  isConnectFailure,
} from '../../github-workflow/scripts/gh-io.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runProcess(cli, args, { stdin, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    let timer = null;
    let timedOut = false;
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        status: code ?? (signal ? 128 + 15 : 1),
      });
    };
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
    }
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', reject);
    // After a timeout kill, a grandchild can keep the pipes open: settle on exit, not close.
    child.on('exit', (code, signal) => {
      if (timedOut) finish(code, signal);
    });
    child.on('close', finish);
    child.stdin.end(stdin ?? '');
  });
}

export function createCliExec({
  url,
  cli = process.env.SLICC_CLI || 'slicc',
  run = runProcess,
  retryDelayMs = CONNECT_RETRY_DELAY_MS,
} = {}) {
  if (!url) throw new Error('the CLI executor needs a join URL (SLICC_JOIN_URL)');
  return async function exec(command, { stdin, timeoutMs } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      const result = await run(cli, [url, 'exec', command], { stdin, timeoutMs });
      if (isConnectFailure(result.status, result.stderr) && attempt < CONNECT_RETRIES) {
        await sleep(retryDelayMs);
        continue;
      }
      return result;
    }
  };
}

/** Pick the SLICC page target from `/json/list`: the UI origin, not a /preview/ tab. */
export function pickPageTarget(targets, uiMatch) {
  return targets.find(
    (t) =>
      t.type === 'page' &&
      t.url.includes(uiMatch) &&
      !t.url.includes('/preview/') &&
      t.webSocketDebuggerUrl
  );
}

/** One CDP `Runtime.evaluate` over a fresh socket; returns the by-value result. */
async function evaluate(wsUrl, expression, WebSocketImpl) {
  const ws = new WebSocketImpl(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`cannot open ${wsUrl}`)), { once: true });
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(
          typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
        );
        if (msg.id === 1) resolve(msg);
      });
      ws.addEventListener('close', () => reject(new Error('CDP socket closed')), { once: true });
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        })
      );
    });
    if (reply.error) throw new Error(`CDP: ${reply.error.message}`);
    if (reply.result?.exceptionDetails) {
      throw new Error(
        `page threw: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`
      );
    }
    return reply.result?.result?.value;
  } finally {
    ws.close();
  }
}

export function createCdpExec({
  cdpUrl,
  uiMatch = 'localhost',
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  if (!cdpUrl) throw new Error('the CDP executor needs --cdp http://127.0.0.1:<port>');
  let stdinCounter = 0;
  async function target() {
    const res = await fetchImpl(`${cdpUrl.replace(/\/$/, '')}/json/list`);
    const t = pickPageTarget(await res.json(), uiMatch);
    if (!t) throw new Error(`no SLICC page matching ${uiMatch} at ${cdpUrl}`);
    return t.webSocketDebuggerUrl;
  }
  return async function exec(command, { stdin } = {}) {
    const wsUrl = await target();
    let line = command;
    if (stdin !== undefined && stdin !== '') {
      // The bridge's exec takes no stdin: stage it as a VFS file and redirect.
      stdinCounter += 1;
      const path = `/tmp/bench/.stdin-${process.pid}-${stdinCounter}`;
      const text = Buffer.isBuffer(stdin) ? stdin.toString('utf8') : String(stdin);
      await evaluate(
        wsUrl,
        `(async () => { const fs = window.__slicc_sprinkleManager.fs; await fs.mkdir('/tmp/bench', { recursive: true }); await fs.writeFile(${JSON.stringify(path)}, ${JSON.stringify(text)}); return true; })()`,
        WebSocketImpl
      );
      // `(exit N)` sets the status without ending the bridge's long-lived session shell.
      line = `{ ${command} ; } < ${path}; __s=$?; rm -f ${path}; (exit $__s)`;
    }
    const r = await evaluate(
      wsUrl,
      `window.__slicc_sprinkleManager.bridge.execHandler(${JSON.stringify(line)})`,
      WebSocketImpl
    );
    return { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '', status: r?.exitCode ?? 1 };
  };
}
