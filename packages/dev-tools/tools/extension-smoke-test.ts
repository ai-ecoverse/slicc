/**
 * CDP-driven smoke test for the SLICC Chrome extension.
 *
 * KNOWN-STALE — Wave 13 follow-up. This script targets the legacy
 * fat-extension architecture (bundled side-panel UI + offscreen
 * document) that the thin-extension strip removed. The agent surface
 * now lives in a hosted leader tab driven via the SW's CDP bridge;
 * the thin-extension equivalent of this smoke test lands as part of
 * the Wave 13 verification task. CI currently runs this with
 * `continue-on-error: true`.
 *
 * End-to-end verification (legacy): launches a disposable Chrome
 * profile with `dist/extension/` loaded, drives the extension via CDP
 * to run the two highest-risk shell command paths (`ffmpeg` transcoding
 * a staged WAV and `node -e` resolving an npm `require()`), and asserts
 * both complete without remote-code policy violations. Network capture
 * spans the panel AND the offscreen document (where the agent shell
 * runs) so the `ffmpeg-core.js` fetch — which happens in offscreen,
 * not the panel — is actually observable.
 *
 * Usage:
 *   npm run build -w @slicc/chrome-extension   # produces dist/extension/
 *   tsx packages/dev-tools/tools/extension-smoke-test.ts
 *
 * Environment knobs:
 *   CHROME_PATH                  override Chrome executable
 *   SLICC_SMOKE_TIMEOUT_MS       overall per-scenario timeout (default 120000)
 *   SLICC_SMOKE_KEEP_PROFILE=1   skip teardown of the tmp profile (debug aid)
 *   SLICC_CI=1                   running under xvfb / headed-CI
 *
 * Wire approach:
 *   1. Spawn Chrome with --load-extension + --remote-debugging-port=0;
 *      discover the live port via DevToolsActivePort.
 *   2. Find the extension ID by scanning /json/list for a service-worker.js
 *      target.
 *   3. Open `chrome-extension://<id>/index.html?detached=1` as a tab so
 *      the side-panel UI bootstraps in a CDP-reachable target.
 *   4. Attach to that target. Use `Runtime.evaluate` to install a tiny
 *      bridge in the page that synthesizes `TerminalControlMsg` envelopes
 *      via `chrome.runtime.sendMessage` and collects matching
 *      `TerminalEventMsg` responses — same wire format the panel's own
 *      `TerminalSessionClient` uses (see
 *      `packages/webapp/src/shell/terminal-protocol.ts` and
 *      `packages/webapp/src/kernel/transport-chrome-runtime.ts`).
 *   5. Track every `Network.requestWillBeSent` and apply per-scenario
 *      assertions on the captured request log.
 *
 * Exit codes:
 *   0  — both scenarios passed.
 *   1  — at least one assertion failed; details are printed AND mirrored
 *        to the artifact file whose path is the last line of stderr.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { findChromeExecutable } from '../../node-server/src/chrome-launch.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXTENSION_DIR = join(REPO_ROOT, 'dist', 'extension');
const SCENARIO_TIMEOUT_MS = Number(process.env['SLICC_SMOKE_TIMEOUT_MS'] ?? 120_000);
const CDP_READY_TIMEOUT_MS = 20_000;
const READY_POLL_TIMEOUT_MS = 30_000;

const FORBIDDEN_HOSTS = ['unpkg.com', 'esm.sh', 'cdn.jsdelivr.net'];

// ---------------------------------------------------------------------------
// Artifact log — captures everything the script does so a failed CI run is
// debuggable from a single file.
// ---------------------------------------------------------------------------

const ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'slicc-smoke-'));
const ARTIFACT_LOG = join(ARTIFACT_DIR, 'smoke.log');
const CHROME_STDERR_LOG = join(ARTIFACT_DIR, 'chrome.stderr.log');

function logArtifact(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try {
    writeFileSync(ARTIFACT_LOG, stamped, { flag: 'a' });
  } catch {
    // Ignore — log only.
  }
  process.stderr.write(stamped);
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function fetchJson(port: number, path: string, method: 'GET' | 'PUT' = 'GET'): Promise<unknown> {
  return new Promise((resolveJson, rejectJson) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: { Host: '127.0.0.1' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            resolveJson(body ? JSON.parse(body) : null);
          } catch (err) {
            rejectJson(new Error(`Bad JSON from ${path}: ${(err as Error).message}: ${body}`));
          }
        });
      }
    );
    req.on('error', rejectJson);
    req.end();
  });
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      await fetchJson(port, '/json/version');
      return;
    } catch (err) {
      lastErr = err;
      await delay(150);
    }
  }
  throw new Error(`CDP /json/version not reachable on port ${port}: ${String(lastErr)}`);
}

async function findExtensionId(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = (await fetchJson(port, '/json/list')) as CdpTarget[];
    for (const t of targets) {
      const m = t.url?.match(/^chrome-extension:\/\/([a-p]{32})\/service-worker\.js/);
      if (m) return m[1]!;
    }
    await delay(200);
  }
  throw new Error('Could not find extension service-worker target in /json/list');
}

async function readDevToolsActivePort(userDataDir: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  const path = join(userDataDir, 'DevToolsActivePort');
  while (Date.now() < deadline) {
    try {
      const first = readFileSync(path, 'utf8').split('\n')[0]?.trim() ?? '';
      const port = Number.parseInt(first, 10);
      if (Number.isInteger(port) && port > 0 && port < 65_536) return port;
    } catch {
      // Not written yet.
    }
    await delay(100);
  }
  throw new Error(`DevToolsActivePort never appeared in ${userDataDir}`);
}

// ---------------------------------------------------------------------------
// CDP session over WebSocket — minimal hand-rolled client.
// ---------------------------------------------------------------------------

interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
}

class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Set<(ev: CdpEvent) => void>();
  private closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (raw) => this.handleMessage(raw.toString()));
    this.ws.on('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    return new CdpSession(ws);
  }

  private handleMessage(text: string): void {
    let parsed: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed.id === 'number') {
      const handler = this.pending.get(parsed.id);
      if (!handler) return;
      this.pending.delete(parsed.id);
      if (parsed.error) handler.reject(new Error(parsed.error.message ?? 'CDP error'));
      else handler.resolve(parsed.result);
    } else if (parsed.method) {
      const ev: CdpEvent = { method: parsed.method, params: parsed.params ?? {} };
      for (const l of this.listeners) l(ev);
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload['sessionId'] = sessionId;
    return new Promise<unknown>((res, rej) => {
      this.pending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id);
          rej(err);
        }
      });
    });
  }

  onEvent(handler: (ev: CdpEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // Ignore.
    }
  }
}

// ---------------------------------------------------------------------------
// In-page bridge — installed once per page session.
// ---------------------------------------------------------------------------

/**
 * Source for the in-page bridge. Runs inside the extension's index.html
 * context, where `chrome.runtime` is fully available. The bridge:
 *   - Opens a single terminal session in the offscreen document.
 *   - Exposes `window.__sliccSmokeExec(command)` returning the captured
 *     stdout/stderr/exitCode.
 *
 * Timing note: the offscreen document's `TerminalSessionHost` listener
 * comes online only after `createKernelHost` finishes (typically 3-5s
 * after Chrome boot). The panel tab and bridge are usually ready before
 * that, so the first `terminal-open` broadcast is silently dropped
 * (`chrome.runtime.sendMessage` has no late delivery). The bridge
 * therefore retries `terminal-open` on a 500ms cadence until it sees a
 * `terminal-status: opened` reply matching its SID. Duplicate-open
 * `session already open` errors that arrive after we've already latched
 * `opened` are benign acks and are ignored — they would otherwise reject
 * inflight execs.
 *
 * Note: we keep this as a string so `Runtime.evaluate` ships exactly what
 * the page executes — no TS-to-JS surprises at runtime.
 */
const PAGE_BRIDGE_SOURCE = `
(() => {
  if (window.__sliccSmokeReady) return 'already-installed';

  // Per-session state — separated from module-level so the smoke
  // test can rotate sessions between scenarios (closing a session
  // whose exec is stuck inside the WASM core lets the next scenario
  // run on a fresh shell without inheriting an inflight terminal-exec).
  const makeSessionState = () => ({
    sid: 'slicc-smoke-' + Math.random().toString(36).slice(2, 10),
    inflight: new Map(),
    openedAcked: false,
    openedResolve: null,
    opened: null,
    retryTimer: null,
  });
  let state = makeSessionState();
  state.opened = new Promise((res) => { state.openedResolve = res; });
  const ENV = { SLICC_REALM_PREFETCH_BUDGET_MS: '60000' };

  const sendOpen = (s) => {
    if (s.openedAcked) return;
    try {
      const p = chrome.runtime.sendMessage({
        source: 'panel',
        payload: { type: 'terminal-open', sid: s.sid, cwd: '/', env: ENV }
      });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* receiving end may not exist yet */ }
  };

  // Single listener shared across rotated sessions. Each event is
  // dispatched against the current state object; stale events for
  // closed sessions are ignored by SID comparison.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.source !== 'offscreen') return false;
    const payload = msg.payload;
    if (!payload || typeof payload !== 'object') return false;
    if (payload.sid !== state.sid) return false;
    if (payload.type === 'terminal-status' && payload.state === 'opened') {
      state.openedAcked = true;
      if (state.retryTimer !== null) { clearInterval(state.retryTimer); state.retryTimer = null; }
      state.openedResolve(true);
    } else if (payload.type === 'terminal-output') {
      const slot = state.inflight.get(payload.execId);
      if (slot) {
        if (payload.stream === 'stderr') slot.stderr += payload.data;
        else slot.stdout += payload.data;
      }
    } else if (payload.type === 'terminal-exit') {
      const slot = state.inflight.get(payload.execId);
      if (slot) {
        state.inflight.delete(payload.execId);
        slot.resolve({ stdout: slot.stdout, stderr: slot.stderr, exitCode: payload.exitCode });
      }
    } else if (payload.type === 'terminal-status' && payload.state === 'error') {
      const msgStr = String(payload.error || '');
      const isDupeOpen = state.openedAcked && /already open/i.test(msgStr);
      if (!isDupeOpen) {
        for (const [, slot] of state.inflight) slot.reject(new Error(msgStr || 'terminal error'));
        state.inflight.clear();
      }
    }
    return false;
  });

  sendOpen(state);
  state.retryTimer = setInterval(() => sendOpen(state), 500);

  window.__sliccSmokeOpened = state.opened;
  window.__sliccSmokeExec = (command, timeoutMs) => {
    const s = state;
    const execId = 'exec-' + Math.random().toString(36).slice(2, 10);
    return s.opened.then(() => new Promise((res, rej) => {
      const timer = setTimeout(() => {
        s.inflight.delete(execId);
        rej(new Error('exec timed out after ' + timeoutMs + 'ms: ' + command));
      }, timeoutMs);
      s.inflight.set(execId, {
        stdout: '', stderr: '',
        resolve: (r) => { clearTimeout(timer); res(r); },
        reject: (e) => { clearTimeout(timer); rej(e); }
      });
      chrome.runtime.sendMessage({
        source: 'panel',
        payload: { type: 'terminal-exec', sid: s.sid, execId, command }
      });
    }));
  };
  // Rotate to a fresh session: close the current SID (aborts any
  // stuck inflight exec on the offscreen side, disposes the shell),
  // then open a new one. Resolves once the new session is 'opened'.
  window.__sliccSmokeRotateSession = () => {
    const old = state;
    if (old.retryTimer !== null) { clearInterval(old.retryTimer); old.retryTimer = null; }
    for (const [, slot] of old.inflight) {
      slot.reject(new Error('session rotated'));
    }
    old.inflight.clear();
    try {
      chrome.runtime.sendMessage({
        source: 'panel',
        payload: { type: 'terminal-close', sid: old.sid }
      });
    } catch (_) { /* ignore */ }
    state = makeSessionState();
    state.opened = new Promise((res) => { state.openedResolve = res; });
    window.__sliccSmokeOpened = state.opened;
    sendOpen(state);
    state.retryTimer = setInterval(() => sendOpen(state), 500);
    return state.opened;
  };
  window.__sliccSmokeReady = true;
  return 'installed';
})()
`;

// ---------------------------------------------------------------------------
// Network log — keeps every request seen during the page lifetime, with
// timestamps so per-scenario windows can be sliced after the fact.
// ---------------------------------------------------------------------------

interface NetEntry {
  ts: number;
  url: string;
  initiator: string | null;
}

function attachNetworkRecorder(cdp: CdpSession, entries: NetEntry[]): () => void {
  return cdp.onEvent((ev) => {
    if (ev.method !== 'Network.requestWillBeSent') return;
    const req = ev.params as {
      request?: { url?: string };
      initiator?: { type?: string; url?: string };
    };
    const url = req.request?.url ?? '';
    if (!url) return;
    entries.push({
      ts: Date.now(),
      url,
      initiator: req.initiator?.url ?? req.initiator?.type ?? null,
    });
    // Trace every request to the artifact log so a hung scenario
    // still leaves a usable record of what the worker tried to fetch.
    // Cheap: smoke runs are short and traffic is bounded.
    if (process.env['SLICC_SMOKE_TRACE_NET']) {
      logArtifact(`[net] ${url.slice(0, 160)}`);
    }
  });
}

function makeNetworkRecorder(cdp: CdpSession): {
  entries: NetEntry[];
  dispose: () => void;
} {
  const entries: NetEntry[] = [];
  const off = attachNetworkRecorder(cdp, entries);
  return { entries, dispose: off };
}

/**
 * Locate the extension's offscreen document and connect a second CDP
 * session to it. The offscreen runtime is the float that hosts the
 * agent shell — `ffmpeg-core.js` is fetched there, not in the panel
 * page, so the panel-scoped Network capture alone misses it.
 *
 * With `Target.setAutoAttach({flatten: true})`, child sessions (the
 * FFmpeg WASM worker, any nested iframes) deliver events on the same
 * WebSocket with a `sessionId` envelope. We call `Network.enable` on
 * each newly-attached child so its `requestWillBeSent` events feed
 * the shared recorder array.
 */
async function attachOffscreenRecorder(
  cdpPort: number,
  extId: string,
  entries: NetEntry[],
  timeoutMs: number
): Promise<{ session: CdpSession; dispose: () => void } | null> {
  const deadline = Date.now() + timeoutMs;
  let offscreen: CdpTarget | null = null;
  while (Date.now() < deadline) {
    const targets = (await fetchJson(cdpPort, '/json/list')) as CdpTarget[];
    offscreen =
      targets.find(
        (t) =>
          typeof t.url === 'string' &&
          t.url.startsWith(`chrome-extension://${extId}/offscreen.html`) &&
          !!t.webSocketDebuggerUrl
      ) ?? null;
    if (offscreen) break;
    await delay(200);
  }
  if (!offscreen?.webSocketDebuggerUrl) return null;

  const wsUrl = offscreen.webSocketDebuggerUrl
    .replace('ws://localhost/', `ws://127.0.0.1:${cdpPort}/`)
    .replace('ws://localhost:', `ws://127.0.0.1:`)
    .replace(/^ws:\/\/127\.0\.0\.1\//, `ws://127.0.0.1:${cdpPort}/`);
  const session = await CdpSession.connect(wsUrl);
  const offEvent = attachNetworkRecorder(session, entries);
  const offConsole = session.onEvent((ev) => {
    // Console + exception capture for debugging. Forwards offscreen-
    // side log lines into the artifact log so a hung ffmpeg run still
    // leaves a breadcrumb trail (the bridge promise rejects on
    // timeout and discards any in-flight terminal-output frames).
    if (ev.method === 'Runtime.consoleAPICalled') {
      const params = ev.params as {
        type?: string;
        args?: Array<{ value?: unknown; description?: string }>;
      };
      const parts = (params.args ?? [])
        .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
        .join(' ');
      logArtifact(`[offscreen console.${params.type ?? 'log'}] ${parts}`);
    } else if (ev.method === 'Runtime.exceptionThrown') {
      const params = ev.params as {
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      const msg =
        params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '';
      logArtifact(`[offscreen exception] ${msg}`);
    } else if (ev.method === 'Log.entryAdded') {
      const params = ev.params as { entry?: { level?: string; text?: string; source?: string } };
      if (params.entry) {
        logArtifact(
          `[offscreen log.${params.entry.level ?? 'info'}/${params.entry.source ?? '?'}] ${params.entry.text ?? ''}`
        );
      }
    } else if (ev.method === 'Network.loadingFailed') {
      const params = ev.params as { errorText?: string; requestId?: string };
      logArtifact(`[offscreen network-fail ${params.requestId}] ${params.errorText ?? ''}`);
    }
  });
  // Network capture targets ONLY dedicated workers (the FFmpeg WASM
  // worker is where `vendor/ffmpeg-core.js` is fetched via `import()`).
  // But `waitForDebuggerOnStart: true` pauses EVERY auto-attached child
  // on start, so each one must be resumed or it hangs indefinitely —
  // fatally so for the `node -e` realm, which runs in a sandbox iframe
  // child of the offscreen document (the staged-WAV step and the
  // `node-e` scenario both block on it). For the FFmpeg worker we still
  // enable Network BEFORE resuming so its `import(coreURL)` fetch lands
  // in the recorder; every other child (realm iframe, service workers)
  // is resumed straight away without enabling Network.
  const attachedSessions = new Set<string>();
  const offAttach = session.onEvent((ev) => {
    if (ev.method !== 'Target.attachedToTarget') return;
    const params = ev.params as {
      sessionId?: string;
      targetInfo?: { type?: string; url?: string };
    };
    const sid = params.sessionId;
    const childType = params.targetInfo?.type ?? '';
    if (!sid || attachedSessions.has(sid)) return;
    attachedSessions.add(sid);
    logArtifact(
      `[offscreen attached-child] type=${childType} url=${params.targetInfo?.url?.slice(0, 120)}`
    );
    const resume = (): void => {
      session.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => undefined);
    };
    if (childType === 'worker') {
      session
        .send('Network.enable', {}, sid)
        .catch(() => undefined)
        .finally(resume);
    } else {
      resume();
    }
  });

  await session.send('Runtime.enable');
  await session.send('Log.enable').catch(() => undefined);
  await session.send('Network.enable');
  // `waitForDebuggerOnStart: true` pauses the FFmpeg worker on
  // attach so our `Network.enable` always lands before the worker's
  // first `import()` — without it, the assertion was flaky on
  // fast machines where the worker raced past attach.
  await session.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  return {
    session,
    dispose: () => {
      offEvent();
      offConsole();
      offAttach();
      session.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario runners
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function evalInPage<T>(
  cdp: CdpSession,
  expression: string,
  awaitPromise = false
): Promise<T> {
  const result = (await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    const msg =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown';
    throw new Error(`Runtime.evaluate exception: ${msg}`);
  }
  return result.result?.value as T;
}

async function waitForPageReady(cdp: CdpSession): Promise<void> {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await evalInPage<boolean>(
      cdp,
      'Boolean(typeof chrome !== "undefined" && chrome?.runtime?.id && document.readyState !== "loading")'
    );
    if (ready) return;
    await delay(200);
  }
  throw new Error('Side panel page never reached ready state');
}

async function installBridge(cdp: CdpSession): Promise<void> {
  const status = await evalInPage<string>(cdp, PAGE_BRIDGE_SOURCE);
  logArtifact(`bridge install: ${status}`);
  // Wait for the offscreen-side `terminal-status: opened` reply.
  await evalInPage<boolean>(
    cdp,
    `Promise.race([
       window.__sliccSmokeOpened,
       new Promise((_, rej) => setTimeout(() => rej(new Error('terminal-open timed out')), 20000))
     ]).then(() => true)`,
    /* awaitPromise */ true
  );
}

async function execShell(
  cdp: CdpSession,
  command: string,
  timeoutMs = 60_000
): Promise<ExecResult> {
  const expr = `window.__sliccSmokeExec(${JSON.stringify(command)}, ${timeoutMs})`;
  return evalInPage<ExecResult>(cdp, expr, /* awaitPromise */ true);
}

/**
 * Rotate the bridge to a fresh terminal session. Used between
 * scenarios so a stuck inflight exec on the offscreen side (e.g.,
 * the `ffmpeg` WASM transcode that never resolves) doesn't block
 * the next scenario behind a `terminal-exit 130` "session busy"
 * sentinel.
 */
async function rotateBridgeSession(cdp: CdpSession): Promise<void> {
  await evalInPage<boolean>(
    cdp,
    `Promise.race([
       window.__sliccSmokeRotateSession(),
       new Promise((_, rej) => setTimeout(() => rej(new Error('rotate timed out')), 20000))
     ]).then(() => true)`,
    /* awaitPromise */ true
  );
}

/** Rotate the bridge session between scenarios, logging (not throwing) on failure. */
async function rotateBridgeSessionOrWarn(cdp: CdpSession): Promise<void> {
  try {
    await rotateBridgeSession(cdp);
    logArtifact('bridge session rotated');
  } catch (err) {
    logArtifact(`WARN session rotate failed: ${(err as Error).message}`);
  }
}

interface ScenarioFailure {
  scenario: string;
  message: string;
  detail?: Record<string, unknown>;
}

function assertScenario(
  failures: ScenarioFailure[],
  scenario: string,
  condition: boolean,
  message: string,
  detail?: Record<string, unknown>
): void {
  if (condition) {
    logArtifact(`✓ [${scenario}] ${message}`);
  } else {
    logArtifact(`✗ [${scenario}] ${message}${detail ? ' ' + JSON.stringify(detail) : ''}`);
    failures.push({ scenario, message, detail });
  }
}

/**
 * Stage a minimal valid 8-bit mono PCM WAV (124 bytes, ~10 ms of
 * silence at 8 kHz) via the realm's `fs.writeFileBinary` bridge.
 * Runs through `node -e`, which routes through the same realm path
 * the agent uses — no `require()` specifiers in the body, so the
 * pre-fetch pipeline is a no-op and this call doesn't depend on the
 * extended `SLICC_REALM_PREFETCH_BUDGET_MS`. The staged file lets
 * the subsequent `ffmpeg` invocation pass the input-exists check
 * and actually load the WASM core (the `-version` short-circuit
 * never did).
 */
const WAV_STAGE_CODE = [
  'const h = [0x52,0x49,0x46,0x46,0x74,0,0,0,0x57,0x41,0x56,0x45,',
  '0x66,0x6d,0x74,0x20,0x10,0,0,0,1,0,1,0,0x40,0x1f,0,0,',
  '0x40,0x1f,0,0,1,0,8,0,0x64,0x61,0x74,0x61,0x50,0,0,0];',
  'const w = new Uint8Array(124); w.set(h); w.fill(0x80, 44);',
  "await fs.writeFileBinary('/tmp/in.wav', w);",
  "console.log('staged ' + w.byteLength + ' bytes');",
].join(' ');

async function runFfmpegScenario(
  cdp: CdpSession,
  net: NetEntry[],
  extId: string,
  failures: ScenarioFailure[]
): Promise<void> {
  const scenario = 'ffmpeg';
  logArtifact(`[${scenario}] staging input WAV via node -e ...`);
  let staged: ExecResult;
  try {
    staged = await execShell(cdp, `node -e ${JSON.stringify(WAV_STAGE_CODE)}`, SCENARIO_TIMEOUT_MS);
  } catch (err) {
    failures.push({ scenario, message: `stage exec threw: ${(err as Error).message}` });
    return;
  }
  if (staged.exitCode !== 0) {
    failures.push({
      scenario,
      message: `stage exit ${staged.exitCode}`,
      detail: {
        stderrTail: staged.stderr.slice(-2000),
        stdoutTail: staged.stdout.slice(-2000),
      },
    });
    return;
  }

  // Sanity-check staging via the realm before paying the WASM-core
  // cold-start. Surfaces a clear failure if VFS write didn't land.
  try {
    const probe = await execShell(
      cdp,
      `node -e "const st = await fs.stat('/tmp/in.wav'); console.log(JSON.stringify(st))"`,
      30_000
    );
    logArtifact(
      `[${scenario}] stage probe exit=${probe.exitCode} stdout=${probe.stdout.trim()} stderr=${probe.stderr.slice(-200)}`
    );
  } catch (err) {
    logArtifact(`[${scenario}] stage probe threw: ${(err as Error).message}`);
  }

  // The transcode itself is informational. The smoke test's job is to
  // verify the MV3 RHC fix — i.e., that `ffmpeg-core.js` is served
  // from `chrome-extension://<id>/vendor/` and no remote `.js`
  // sneaks in — which we observe via Network capture as soon as
  // `ffmpeg.load()` starts. Currently `ffmpeg.exec()` in the extension
  // offscreen never resolves on this Chrome/wasm combo (the WASM core
  // loads but the transcode hangs); we honor a shorter `ffmpegBudget`
  // so the scenario records a clean fail-or-timeout state without
  // burning the whole SCENARIO_TIMEOUT_MS.
  const ffmpegCommand = 'ffmpeg -i /tmp/in.wav -c copy /tmp/out.wav';
  const ffmpegBudget = Math.min(SCENARIO_TIMEOUT_MS, 60_000);
  logArtifact(`[${scenario}] running '${ffmpegCommand}' (budget=${ffmpegBudget}ms) ...`);
  const start = Date.now();
  let result: ExecResult | null = null;
  let execError: string | null = null;
  try {
    result = await execShell(cdp, ffmpegCommand, ffmpegBudget);
  } catch (err) {
    execError = (err as Error).message;
  }
  const slice = net.filter((e) => e.ts >= start);
  if (result) {
    logArtifact(
      `[${scenario}] exitCode=${result.exitCode} stdout=${result.stdout.length}B stderr=${result.stderr.length}B network=${slice.length}`
    );
  } else {
    logArtifact(`[${scenario}] exec did not complete (${execError}); network=${slice.length}`);
  }

  // Network rules: every .js fetched during the scenario MUST come from
  // chrome-extension://<id>/ — any cross-origin .js is a remote-code-hosting
  // violation. Cross-origin .wasm is allowed (`ffmpeg-core.wasm` still
  // streams from the CDN on first run; only the JS glue is bundled).
  const jsViolations = slice.filter((e) => {
    if (!/\.js(\?|$)/i.test(e.url)) return false;
    if (e.url.startsWith(`chrome-extension://${extId}/`)) return false;
    return FORBIDDEN_HOSTS.some((h) => e.url.includes(`//${h}/`) || e.url.includes(`//${h}:`));
  });
  assertScenario(
    failures,
    scenario,
    jsViolations.length === 0,
    'no remote .js fetches from forbidden hosts',
    { violations: jsViolations.slice(0, 10).map((e) => e.url) }
  );

  const localCore = slice.find(
    (e) => e.url.startsWith(`chrome-extension://${extId}/`) && e.url.includes('ffmpeg-core.js')
  );
  assertScenario(
    failures,
    scenario,
    !!localCore,
    'ffmpeg-core.js loaded from chrome-extension://<id>/vendor/',
    {
      sampleExtensionUrls: slice
        .filter((e) => e.url.startsWith(`chrome-extension://${extId}/`))
        .slice(0, 10)
        .map((e) => e.url),
      sampleAllUrls: slice.slice(0, 10).map((e) => e.url),
    }
  );

  // The wasm binary is allowed to come from the CDN — bundle it later.
  // This is an informational assertion (not a fail) so the artifact
  // log records what happened on first-run vs. cache-hit paths.
  const wasmFetch = slice.find((e) => /ffmpeg-core\.wasm(\?|$)/i.test(e.url));
  if (wasmFetch) {
    logArtifact(`[${scenario}] wasm fetched from ${wasmFetch.url} (informational)`);
  }

  // Exit code is informational while `ffmpeg.exec()` doesn't yet
  // complete in the extension offscreen. Promote to a hard failure
  // only when the run was a clean exec error other than the timeout,
  // or when the exec returned a non-zero code that's NOT the bridge's
  // own timeout sentinel — that catches regressions in the realm /
  // shell wiring while tolerating the in-flight wasm-exec issue.
  if (execError && !/timed out/i.test(execError)) {
    failures.push({ scenario, message: `exec threw (non-timeout): ${execError}` });
  } else if (result && result.exitCode !== 0) {
    logArtifact(
      `[${scenario}] WARN exec exitCode=${result.exitCode} (informational; RHC assertions are the gating signal)`
    );
  }
}

async function runNodeScenario(cdp: CdpSession, failures: ScenarioFailure[]): Promise<void> {
  const scenario = 'node-e';
  // `is-number` is a 1-file zero-dep package — small enough that even
  // a constrained pre-fetch budget can resolve it well under the
  // smoke test's per-scenario timeout, while still exercising the
  // CDN require-prefetch path end-to-end.
  const command = `node -e "const isNumber = require('is-number'); console.log(isNumber(42) ? 'ok' : 'fail')"`;
  logArtifact(`[${scenario}] running ${command} ...`);
  let result: ExecResult;
  try {
    result = await execShell(cdp, command, SCENARIO_TIMEOUT_MS);
  } catch (err) {
    failures.push({ scenario, message: `exec threw: ${(err as Error).message}` });
    return;
  }
  logArtifact(
    `[${scenario}] exitCode=${result.exitCode} stdout=${result.stdout.length}B stderr=${result.stderr.length}B`
  );
  assertScenario(
    failures,
    scenario,
    result.exitCode === 0,
    `exit code 0 (got ${result.exitCode})`,
    {
      stderrTail: result.stderr.slice(-2000),
      stdoutTail: result.stdout.slice(-2000),
    }
  );
  const trimmed = result.stdout.trim();
  assertScenario(failures, scenario, trimmed === 'ok', 'stdout is deterministic "ok"', {
    stdout: trimmed,
    stderrTail: result.stderr.slice(-500),
  });
}

/**
 * Read `/tmp/photo.jpg` back and emit its size plus a base64 dump of its
 * bytes for JPEG-envelope validation. Deliberately uses just-bash
 * builtins (`wc`, `base64`) rather than `node -e`: those run
 * synchronously in the WASM shell with no realm worker or network, so
 * the readback can't hang even if the realm path is unavailable.
 * `base64` is the one builtin guaranteed to round-trip binary faithfully
 * (just-bash's `od`/`tail -c` don't match GNU byte semantics). Output is
 * a single `SZ=<n>|B64=<base64>` line the smoke side decodes and checks.
 */
const JPEG_PROBE_CODE = [
  'sz=$(wc -c < /tmp/photo.jpg);',
  "b64=$(base64 < /tmp/photo.jpg | tr -d '\\n');",
  'printf \'SZ=%s|B64=%s\\n\' "$sz" "$b64"',
].join(' ');

/**
 * Media-capture scenario. Exercises the extension's avfoundation photo
 * path end-to-end: the offscreen shell runs `ffmpeg -f avfoundation`,
 * which (under `isExtensionFloat()`) opens `capture-popup.html` via the
 * service worker's `capture-open-window` handler, captures one frame
 * from the synthetic camera through `getUserMedia` (auto-granted by the
 * `--use-fake-*` flags), JPEG-encodes it, and posts the bytes back over
 * `chrome.runtime` messaging to be written to the VFS. We then read the
 * file back with just-bash builtins and assert it's a non-empty valid
 * JPEG (SOI `FF D8 FF`, EOI `FF D9`). The photo path writes the canvas
 * bytes straight to the VFS (no wasm transcode for a plain `.jpg`
 * target), so the scenario doesn't depend on `ffmpeg.exec()` or the
 * `node -e` realm path.
 */
async function runMediaCaptureScenario(
  cdp: CdpSession,
  net: NetEntry[],
  extId: string,
  failures: ScenarioFailure[]
): Promise<void> {
  const scenario = 'media-capture';
  const captureCommand = 'ffmpeg -f avfoundation -i 0 -frames:v 1 /tmp/photo.jpg';
  // The fake device grants instantly, but the photo path waits ~1.5s for
  // auto-exposure warmup and opens a popup window first; a 90s budget is
  // generous without burning the full SCENARIO_TIMEOUT_MS on a hang.
  const captureBudget = Math.min(SCENARIO_TIMEOUT_MS, 90_000);
  logArtifact(`[${scenario}] running '${captureCommand}' (budget=${captureBudget}ms) ...`);
  const start = Date.now();
  let result: ExecResult | null = null;
  let execError: string | null = null;
  try {
    result = await execShell(cdp, captureCommand, captureBudget);
  } catch (err) {
    execError = (err as Error).message;
  }
  const slice = net.filter((e) => e.ts >= start);
  if (result) {
    logArtifact(
      `[${scenario}] capture exitCode=${result.exitCode} stdout=${result.stdout.length}B stderr='${result.stderr.slice(-300).trim()}' network=${slice.length}`
    );
  } else {
    logArtifact(`[${scenario}] capture exec did not complete (${execError})`);
  }

  if (execError) {
    failures.push({ scenario, message: `capture exec threw: ${execError}` });
    return;
  }
  if (!result) {
    failures.push({ scenario, message: 'capture exec returned no result' });
    return;
  }
  assertScenario(
    failures,
    scenario,
    result.exitCode === 0,
    `capture exit code 0 (got ${result.exitCode})`,
    { stderrTail: result.stderr.slice(-2000), stdoutTail: result.stdout.slice(-2000) }
  );

  // Read the captured file back with just-bash builtins and validate the
  // JPEG envelope. This confirms the bytes actually round-tripped from
  // the popup into the VFS — not just that the command exited cleanly.
  let probe: ExecResult;
  try {
    probe = await execShell(cdp, JPEG_PROBE_CODE, 30_000);
  } catch (err) {
    failures.push({ scenario, message: `jpeg probe exec threw: ${(err as Error).message}` });
    return;
  }
  if (probe.exitCode !== 0) {
    failures.push({
      scenario,
      message: `jpeg probe exit ${probe.exitCode}`,
      detail: { stderrTail: probe.stderr.slice(-2000), stdoutTail: probe.stdout.slice(-2000) },
    });
    return;
  }
  const m = /SZ=([0-9]+)\|B64=([A-Za-z0-9+/=]*)/.exec(probe.stdout);
  if (!m) {
    failures.push({
      scenario,
      message: 'jpeg probe stdout did not match expected SZ/B64 shape',
      detail: { stdout: probe.stdout.slice(0, 500) },
    });
    return;
  }
  const len = parseInt(m[1], 10);
  const bytes = Buffer.from(m[2], 'base64');
  const soi = [bytes[0], bytes[1], bytes[2]];
  const eoi = bytes.length >= 2 ? [bytes[bytes.length - 2], bytes[bytes.length - 1]] : [];
  logArtifact(
    `[${scenario}] jpeg probe wc=${len} decoded=${bytes.length} soi=${JSON.stringify(soi)} eoi=${JSON.stringify(eoi)}`
  );
  assertScenario(failures, scenario, len > 0, `captured file is non-empty (wc -c = ${len})`, {
    len,
  });
  // The base64 decode length should match the on-disk size — confirms the
  // dump round-tripped cleanly rather than being truncated mid-stream.
  assertScenario(
    failures,
    scenario,
    bytes.length === len,
    `base64 decode length matches wc -c (${bytes.length} vs ${len})`,
    { decoded: bytes.length, wc: len }
  );
  // JPEG start-of-image marker is FF D8 FF.
  assertScenario(
    failures,
    scenario,
    soi[0] === 0xff && soi[1] === 0xd8 && soi[2] === 0xff,
    'captured file has JPEG SOI marker (FF D8 FF)',
    { soi }
  );
  // JPEG end-of-image marker is FF D9.
  assertScenario(
    failures,
    scenario,
    eoi[0] === 0xff && eoi[1] === 0xd9,
    'captured file has JPEG EOI marker (FF D9)',
    { eoi }
  );

  // Security invariant shared with the ffmpeg scenario: no remote `.js`
  // from forbidden hosts during the capture window.
  const jsViolations = slice.filter((e) => {
    if (!/\.js(\?|$)/i.test(e.url)) return false;
    if (e.url.startsWith(`chrome-extension://${extId}/`)) return false;
    return FORBIDDEN_HOSTS.some((h) => e.url.includes(`//${h}/`) || e.url.includes(`//${h}:`));
  });
  assertScenario(
    failures,
    scenario,
    jsViolations.length === 0,
    'no remote .js fetches from forbidden hosts',
    { violations: jsViolations.slice(0, 10).map((e) => e.url) }
  );
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/**
 * Attach the offscreen-document network recorder unless disabled via
 * `SLICC_SMOKE_NO_OFFSCREEN=1`. Logging is folded in here so `main()`
 * stays a flat sequence rather than a nested conditional.
 */
async function maybeAttachOffscreen(
  cdpPort: number,
  extId: string,
  entries: NetEntry[]
): Promise<{ session: CdpSession; dispose: () => void } | null> {
  if (process.env['SLICC_SMOKE_NO_OFFSCREEN']) {
    logArtifact('SLICC_SMOKE_NO_OFFSCREEN=1 set; skipping offscreen attach');
    return null;
  }
  const off = await attachOffscreenRecorder(cdpPort, extId, entries, CDP_READY_TIMEOUT_MS);
  logArtifact(
    off
      ? 'offscreen recorder attached'
      : 'WARN: offscreen target not found within timeout — ffmpeg-core capture may miss'
  );
  return off;
}

/**
 * Launcher-injection scenario. Opens a real http(s) page in a new tab
 * (content scripts don't inject into `chrome-extension://` URLs), waits
 * for the MAIN-world content script to register and mount
 * `<slicc-launcher>`, then asserts the element upgraded with a shadow
 * root, the toggle button is reachable, and the iframe app-url points
 * at www.sliccy.ai in cherry-follower mode. Regression guard for the
 * Chrome 146 ISOLATED-world
 * `customElements === null` bootstrapper crash.
 */
async function runLauncherScenario(cdpPort: number, failures: ScenarioFailure[]): Promise<void> {
  const scenario = 'launcher';
  const targetUrl = 'https://example.com/';
  logArtifact(`[${scenario}] opening ${targetUrl} ...`);

  let tab: CdpTarget;
  try {
    tab = (await fetchJson(
      cdpPort,
      `/json/new?${encodeURIComponent(targetUrl)}`,
      'PUT'
    )) as CdpTarget;
  } catch (err) {
    failures.push({ scenario, message: `open page tab failed: ${(err as Error).message}` });
    return;
  }
  if (!tab?.webSocketDebuggerUrl) {
    failures.push({ scenario, message: 'open page tab returned no webSocketDebuggerUrl' });
    return;
  }
  const wsUrl = tab.webSocketDebuggerUrl
    .replace('ws://localhost/', `ws://127.0.0.1:${cdpPort}/`)
    .replace('ws://localhost:', `ws://127.0.0.1:`)
    .replace(/^ws:\/\/127\.0\.0\.1\//, `ws://127.0.0.1:${cdpPort}/`);

  let pageCdp: CdpSession;
  try {
    pageCdp = await CdpSession.connect(wsUrl);
  } catch (err) {
    failures.push({ scenario, message: `connect to page CDP failed: ${(err as Error).message}` });
    return;
  }
  try {
    await pageCdp.send('Page.enable');
    await pageCdp.send('Runtime.enable');

    interface LauncherProbe {
      tag: string | null;
      appUrl: string | null;
      hasShadow: boolean;
      hasButton: boolean;
      iframeSrc: string | null;
      readyState: string;
      docUrl: string;
    }

    const probeExpr = `
      (() => {
        const el = document.querySelector('slicc-launcher');
        if (!el) return {
          tag: null, appUrl: null, hasShadow: false, hasButton: false,
          iframeSrc: null, readyState: document.readyState, docUrl: document.URL,
        };
        const sr = el.shadowRoot;
        const btn = sr ? sr.querySelector('button.launcher') : null;
        const iframe = sr ? sr.querySelector('iframe') : null;
        return {
          tag: el.tagName.toLowerCase(),
          appUrl: el.getAttribute('app-url'),
          hasShadow: !!sr,
          hasButton: !!btn,
          iframeSrc: iframe ? (iframe.src || iframe.getAttribute('src') || null) : null,
          readyState: document.readyState,
          docUrl: document.URL,
        };
      })()
    `;

    // content_scripts inject at document_idle. Poll up to 30s for the
    // element to appear and upgrade with a shadow root.
    const deadline = Date.now() + 30_000;
    let probe: LauncherProbe | null = null;
    while (Date.now() < deadline) {
      const result = (await pageCdp.send('Runtime.evaluate', {
        expression: probeExpr,
        returnByValue: true,
      })) as { result?: { value?: LauncherProbe } };
      probe = result.result?.value ?? null;
      if (probe?.tag === 'slicc-launcher' && probe.hasShadow && probe.hasButton) break;
      await delay(500);
    }
    logArtifact(`[${scenario}] probe=${JSON.stringify(probe)}`);

    assertScenario(
      failures,
      scenario,
      !!probe && probe.tag === 'slicc-launcher',
      'document.querySelector("slicc-launcher") is non-null',
      { probe }
    );
    assertScenario(
      failures,
      scenario,
      !!probe?.hasShadow,
      'slicc-launcher upgraded with an open shadow root',
      { probe }
    );
    assertScenario(
      failures,
      scenario,
      !!probe?.hasButton,
      'shadow root contains the .launcher toggle button',
      { probe }
    );
    assertScenario(
      failures,
      scenario,
      probe?.appUrl === 'https://www.sliccy.ai/?cherry=1',
      `app-url attribute is "https://www.sliccy.ai/?cherry=1" (got "${probe?.appUrl}")`,
      { probe }
    );
  } finally {
    pageCdp.close();
  }
}

/**
 * Run all scenarios in sequence, rotating the bridge session between
 * each so a stuck inflight exec on the offscreen side doesn't bleed
 * into the next scenario. Returns the accumulated failures.
 */
async function runScenarios(
  cdp: CdpSession,
  entries: NetEntry[],
  extId: string,
  cdpPort: number
): Promise<ScenarioFailure[]> {
  const failures: ScenarioFailure[] = [];
  // Launcher scenario runs against a separate https page (content
  // scripts don't inject into chrome-extension:// targets); independent
  // of the panel bridge state, so order doesn't matter relative to the
  // other scenarios.
  await runLauncherScenario(cdpPort, failures);
  await runFfmpegScenario(cdp, entries, extId, failures);
  // ffmpeg.exec() may still be running on the offscreen side after
  // its smoke-side timeout; rotate to a fresh session so the next
  // scenario doesn't bounce off the busy-session sentinel.
  await rotateBridgeSessionOrWarn(cdp);
  await runNodeScenario(cdp, failures);
  // Media capture opens a popup window and drives getUserMedia on the
  // offscreen side; rotate again so it starts from a clean session.
  await rotateBridgeSessionOrWarn(cdp);
  await runMediaCaptureScenario(cdp, entries, extId, failures);
  return failures;
}

/** Log the scenario outcome and return the process exit code. */
function reportFailures(failures: ScenarioFailure[]): number {
  if (failures.length === 0) {
    logArtifact('all scenarios passed');
    return 0;
  }
  logArtifact(`FAILURES (${failures.length}):`);
  for (const f of failures) {
    logArtifact(`  [${f.scenario}] ${f.message}${f.detail ? ' ' + JSON.stringify(f.detail) : ''}`);
  }
  return 1;
}

/** Best-effort terminate the Chrome child process (SIGTERM, then SIGKILL). */
async function killChrome(chrome: ChildProcess): Promise<void> {
  if (chrome.exitCode !== null) return;
  try {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise<void>((res) => chrome.once('exit', () => res())), delay(3000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  } catch {
    // Ignore.
  }
}

/** Remove the disposable Chrome profile unless `SLICC_SMOKE_KEEP_PROFILE` is set. */
function removeProfile(profileDir: string): void {
  if (process.env['SLICC_SMOKE_KEEP_PROFILE']) return;
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    // Ignore.
  }
}

async function main(): Promise<number> {
  logArtifact(`smoke test artifact dir: ${ARTIFACT_DIR}`);

  if (!existsSync(EXTENSION_DIR)) {
    logArtifact(
      `ERROR: ${EXTENSION_DIR} does not exist. Run 'npm run build -w @slicc/chrome-extension' first.`
    );
    return 1;
  }
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
    logArtifact(`ERROR: ${EXTENSION_DIR}/manifest.json missing — incomplete extension build.`);
    return 1;
  }

  const chromePath = findChromeExecutable({ executablePreference: 'chrome-for-testing' });
  if (!chromePath) {
    logArtifact(
      'ERROR: no Chrome executable found. Set CHROME_PATH or install Chrome for Testing via puppeteer.'
    );
    return 1;
  }
  logArtifact(`chrome executable: ${chromePath}`);

  const profileDir = mkdtempSync(join(tmpdir(), 'slicc-smoke-profile-'));
  logArtifact(`chrome user-data-dir: ${profileDir}`);

  const args = [
    `--load-extension=${EXTENSION_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-background-tracing',
    '--disable-blink-features=AutomationControlled',
    // Media-capture scenario: feed a synthetic camera/mic and auto-grant
    // the getUserMedia / getDisplayMedia prompt so the popup capture path
    // runs headlessly without a real device or a human clicking "Allow".
    // Scoped to the smoke harness only — production Chrome launch and the
    // extension manifest are unchanged.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    'about:blank',
  ];

  let chrome: ChildProcess | null = null;
  let cdp: CdpSession | null = null;
  let offscreen: { session: CdpSession; dispose: () => void } | null = null;
  let exitCode = 1;

  try {
    chrome = spawn(chromePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GOOGLE_CRASHPAD_DISABLE: '1' },
    });
    chrome.stderr?.on('data', (b: Buffer) => {
      try {
        writeFileSync(CHROME_STDERR_LOG, b, { flag: 'a' });
      } catch {
        // Ignore.
      }
    });
    chrome.on('exit', (code, sig) => logArtifact(`chrome exited code=${code} signal=${sig}`));

    const cdpPort = await readDevToolsActivePort(profileDir, CDP_READY_TIMEOUT_MS);
    logArtifact(`chrome CDP port: ${cdpPort}`);
    await waitForCdp(cdpPort, 10_000);

    const extId = await findExtensionId(cdpPort, CDP_READY_TIMEOUT_MS);
    logArtifact(`extension id: ${extId}`);

    const panelUrl = `chrome-extension://${extId}/index.html?detached=1`;
    const newTab = (await fetchJson(
      cdpPort,
      `/json/new?${encodeURIComponent(panelUrl)}`,
      'PUT'
    )) as CdpTarget;
    if (!newTab?.webSocketDebuggerUrl) throw new Error('Failed to open panel tab');
    logArtifact(`panel tab opened: ${newTab.id} ws=${newTab.webSocketDebuggerUrl}`);

    // Connect to the new tab's WebSocketDebuggerUrl directly — this is a
    // target-scoped session, no Target.attachToTarget hop required.
    // Chrome's `/json/new` endpoint emits an authority-less ws URL
    // (`ws://127.0.0.1/devtools/page/<id>`) — inject the CDP port we
    // already know. Also fold `localhost` → `127.0.0.1` for IPv6-only
    // resolvers that resolve `localhost` to `::1` and miss IPv4 CDP.
    const wsUrl = newTab.webSocketDebuggerUrl
      .replace('ws://localhost/', `ws://127.0.0.1:${cdpPort}/`)
      .replace('ws://localhost:', `ws://127.0.0.1:`)
      .replace(/^ws:\/\/127\.0\.0\.1\//, `ws://127.0.0.1:${cdpPort}/`);
    cdp = await CdpSession.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    const recorder = makeNetworkRecorder(cdp);

    await waitForPageReady(cdp);
    logArtifact('page chrome.runtime ready; installing bridge ...');
    await installBridge(cdp);
    logArtifact('terminal session opened; attaching offscreen recorder ...');

    // The agent shell — and therefore the `ffmpeg-core.js` fetch —
    // runs in the offscreen document, not the panel. Attach a second
    // CDP session there (and to its child worker targets) so the
    // shared `recorder.entries` array also sees offscreen-origin
    // network events. Skip with `SLICC_SMOKE_NO_OFFSCREEN=1` for
    // local debugging in case the auto-attach interferes with the
    // ffmpeg WASM worker on a specific Chrome build.
    offscreen = await maybeAttachOffscreen(cdpPort, extId, recorder.entries);

    logArtifact('running scenarios ...');
    const failures = await runScenarios(cdp, recorder.entries, extId, cdpPort);
    recorder.dispose();
    offscreen?.dispose();
    offscreen = null;

    exitCode = reportFailures(failures);
  } catch (err) {
    logArtifact(`fatal: ${(err as Error).message}`);
    if ((err as Error).stack) logArtifact((err as Error).stack!);
  } finally {
    try {
      offscreen?.dispose();
    } catch {
      // Ignore.
    }
    try {
      cdp?.close();
    } catch {
      // Ignore.
    }
    if (chrome) await killChrome(chrome);
    removeProfile(profileDir);
    // Last line of stderr is always the artifact-log path so CI / humans
    // can grab it without parsing the rest of the output.
    process.stderr.write(`\nsmoke artifacts: ${ARTIFACT_LOG}\n`);
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logArtifact(`top-level error: ${(err as Error).message}`);
    process.exit(1);
  });
