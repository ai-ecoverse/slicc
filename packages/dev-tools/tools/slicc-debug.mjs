#!/usr/bin/env node
/**
 * slicc-debug.mjs — CDP diagnostic toolkit for SLICC standalone dev harness.
 *
 * Usage:
 *   node packages/dev-tools/tools/slicc-debug.mjs [--url <substr>] <command> [args...]
 *
 * Commands:
 *   targets                     List all CDP targets (pages, workers, etc.)
 *   logs [--target=page|worker] Stream console output & errors (Ctrl-C to stop)
 *   vfs ls <path>               List VFS directory contents
 *   vfs cat <path>              Read a VFS file (text)
 *   eval <expression>           Evaluate JS in the page context
 *   shell <command>             Run a shell command via the sprinkle exec bridge
 *   chat <prompt>               Send a prompt to the SLICC agent
 *
 * Page-target selection:
 *   --url <substring>           Pick the page target whose URL contains <substring>
 *   --url-pattern <regex>       Pick the page target whose URL matches <regex>
 *                               (default: SLICC_TARGET_URL, then the SLICC
 *                                dev-server port heuristic localhost:57xx)
 *
 * Payload input (eval / shell):
 *   --file <path>               Read the payload from a local file ('-' = stdin).
 *                               Mutually exclusive with an inline payload.
 *
 * Shell working directory:
 *   --cwd <path>                cwd for the shell bridge
 *                               (precedence: --cwd > SLICC_CWD > /workspace)
 *
 * Environment:
 *   SLICC_CDP_PORT    Override CDP port (default: auto-detect from thin-bridge on :5710)
 *   SLICC_BRIDGE_PORT Override bridge port (default: 5710)
 *   SLICC_TARGET_URL  Default for --url (page-target URL substring)
 *   SLICC_CWD         Default shell cwd (below --cwd, above /workspace)
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const BRIDGE_PORT = process.env.SLICC_BRIDGE_PORT || '5710';

/** Default shell cwd when neither --cwd nor SLICC_CWD is set. */
export const DEFAULT_CWD = '/workspace';

/**
 * SLICC dev-server / parallel-instance port range (localhost:5710/5720/5730/…).
 * Used to disambiguate when multiple page targets are open and the URL filter
 * does not narrow to a single match.
 */
export const DEV_SERVER_PORT_RE = /localhost:57\d\d/;

/** Flags that consume the following argv token as their value. */
const VALUE_FLAGS = new Set(['url', 'url-pattern', 'cwd', 'file', 'target']);

// ── argv parsing (pure, exported for tests) ───────────────────────────────────

/**
 * Split argv into recognized flags and positional tokens. Supports both
 * `--flag value` and `--flag=value` forms for the known value-flags. Unknown
 * `--tokens` are preserved as positionals so quoted shell commands survive
 * intact (e.g. `shell git --version`).
 */
export function parseArgv(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (VALUE_FLAGS.has(name)) {
        flags[name] = eq === -1 ? args[++i] : a.slice(eq + 1);
        continue;
      }
    }
    positional.push(a);
  }
  return { flags, positional };
}

/**
 * Resolve the page-target URL filter. Precedence:
 *   --url-pattern (regex) > --url (substring) > SLICC_TARGET_URL (substring).
 * Returns `{ value, isRegex }` or `null` when nothing is configured.
 */
export function resolveUrlFilter(flags = {}, env = process.env) {
  if (flags['url-pattern'] !== undefined) return { value: flags['url-pattern'], isRegex: true };
  if (flags.url !== undefined) return { value: flags.url, isRegex: false };
  if (env.SLICC_TARGET_URL) return { value: env.SLICC_TARGET_URL, isRegex: false };
  return null;
}

/** Resolve the shell cwd. Precedence: --cwd > SLICC_CWD > DEFAULT_CWD. */
export function resolveCwd(flags = {}, env = process.env) {
  if (flags.cwd !== undefined) return flags.cwd;
  if (env.SLICC_CWD) return env.SLICC_CWD;
  return DEFAULT_CWD;
}

/** True when `url` matches the resolved filter (substring or regex). */
export function targetMatchesUrl(url, filter) {
  if (!filter) return true;
  const u = url || '';
  if (filter.isRegex) {
    try {
      return new RegExp(filter.value).test(u);
    } catch {
      return false;
    }
  }
  return u.includes(filter.value);
}

/**
 * Pick a page target from `targets`. When a filter narrows to exactly one
 * page, use it. Otherwise (multiple matches, or no filter) prefer a SLICC
 * dev-server port (localhost:57xx); fall back to the first page when nothing
 * matches.
 */
export function pickPageTarget(targets, filter) {
  const pages = targets.filter((t) => t.type === 'page');
  if (pages.length === 0) return undefined;
  let candidates = pages;
  if (filter) {
    const matched = pages.filter((t) => targetMatchesUrl(t.url, filter));
    if (matched.length === 1) return matched[0];
    if (matched.length > 1) candidates = matched;
    // matched.length === 0 → fall through to the heuristic over all pages.
  }
  return candidates.find((t) => DEV_SERVER_PORT_RE.test(t.url || '')) ?? candidates[0];
}

/** Resolve the target for a CDP attach by `type`, honouring the URL filter for pages. */
export function findTarget(targets, type, filter) {
  if (type === 'worker' || type === 'kernel') {
    return targets.find((t) => t.type === 'worker' && (t.url || '').includes('kernel-worker'));
  }
  if (type === 'blob' || type === 'realm') {
    return targets.find((t) => t.type === 'worker' && (t.url || '').startsWith('blob:'));
  }
  return pickPageTarget(targets, filter);
}

/**
 * Resolve the payload source for `eval` / `shell`. Returns the inline payload
 * and/or `--file` path; throws if both are supplied.
 */
export function resolvePayloadSource(flags = {}, restArgs = []) {
  const filePath = flags.file;
  const positionalPayload = restArgs.join(' ');
  if (filePath !== undefined && positionalPayload.length > 0) {
    throw new Error('Cannot combine --file with an inline payload; provide one or the other.');
  }
  return { filePath, positionalPayload };
}

/** Read a readable stream to a UTF-8 string. */
async function readStreamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read the resolved payload: a `--file` file, `-` (stdin), or the inline
 * positional payload. `deps` is injectable for tests.
 */
export async function readPayload(
  { filePath, positionalPayload },
  { readFile = fsReadFile, stdin = process.stdin } = {}
) {
  if (filePath === '-') return readStreamToString(stdin);
  if (filePath !== undefined) return readFile(filePath, 'utf8');
  return positionalPayload;
}

/** Single-quote a string for safe embedding in a bash command. */
function shellSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function findCdpPort() {
  if (process.env.SLICC_CDP_PORT) return process.env.SLICC_CDP_PORT;
  // The thin-bridge proxies CDP at ws://localhost:5710/cdp, but for raw
  // target listing we need the actual Chrome CDP port.  Try /json on common
  // ports, or parse the bridge log.
  for (const port of ['9222', '9223']) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (r.ok) return port;
    } catch {}
  }
  // Scan high ports that Chrome for Testing typically uses
  try {
    const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/json`, {
      signal: AbortSignal.timeout(1000),
    });
    if (r.ok) {
      // The thin bridge doesn't expose /json — but let's try the bridge log approach
    }
  } catch {}
  // Last resort: scan recent Chrome processes for --remote-debugging-port
  const { execSync } = await import('node:child_process');
  try {
    const ps = execSync('ps aux', { encoding: 'utf8' });
    const match = ps.match(/--remote-debugging-port=(\d+)/);
    if (match) return match[1];
  } catch {}
  throw new Error('Cannot find CDP port. Set SLICC_CDP_PORT or start the dev harness.');
}

async function getTargets(cdpPort) {
  const r = await fetch(`http://127.0.0.1:${cdpPort}/json`);
  return r.json();
}

function connectTarget(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const pending = {};
    ws.on('open', () => resolve({ ws, send, close: () => ws.close() }));
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id && pending[msg.id]) {
        pending[msg.id](msg);
        delete pending[msg.id];
      }
      if (ws._eventHandler) ws._eventHandler(msg);
    });
    function send(method, params, sessionId) {
      const id = msgId++;
      const msg = { id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
      return new Promise((r) => {
        pending[id] = r;
      });
    }
  });
}

async function attachToTarget(cdpPort, type = 'page', urlFilter = null) {
  const targets = await getTargets(cdpPort);
  const target = findTarget(targets, type, urlFilter);
  if (!target) throw new Error(`No ${type} target found`);
  // Print the resolved target on stderr so the operator can verify visually
  // without polluting stdout (which carries the payload result for piping).
  console.error(`→ attached to ${target.type}: ${target.url || target.title || '(unknown)'}`);
  const conn = await connectTarget(target.webSocketDebuggerUrl);
  await conn.send('Runtime.enable');
  return conn;
}

async function evalIn(conn, expression) {
  const r = await conn.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return r.result?.result?.value ?? r.result?.result ?? r.result;
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdTargets(cdpPort) {
  const targets = await getTargets(cdpPort);
  console.log('CDP targets on port', cdpPort, '\n');
  for (const t of targets) {
    console.log(
      `  ${t.type.padEnd(10)} ${(t.title || '').slice(0, 60).padEnd(62)} ${(t.url || '').slice(0, 80)}`
    );
  }
}

async function cmdLogs(cdpPort, targetFilter, urlFilter = null) {
  const targets = await getTargets(cdpPort);
  const target = findTarget(targets, targetFilter, urlFilter);
  if (!target) throw new Error(`No '${targetFilter || 'page'}' target found`);
  console.log(`Streaming logs from ${target.type}: ${target.title || target.url}`);
  console.log('Press Ctrl-C to stop.\n');
  const conn = await connectTarget(target.webSocketDebuggerUrl);
  await conn.send('Runtime.enable');
  await conn.send('Log.enable');
  conn.ws._eventHandler = (msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const p = msg.params;
      const text = (p.args || [])
        .map((a) => a.value || a.description || JSON.stringify(a))
        .join(' ');
      console.log(`[${p.type}]`, text.slice(0, 500));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const ex = msg.params.exceptionDetails;
      console.log('[EXCEPTION]', ex?.text, ex?.exception?.description?.slice(0, 300));
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error' || e.level === 'warning') {
        console.log(`[${e.level.toUpperCase()}]`, (e.text || '').slice(0, 300));
      }
    }
  };
  // keep alive
  await new Promise(() => {});
}

/** Helper expression for VFS BroadcastChannel reads (page context). */
function vfsReadExpr(safePath) {
  // Wire contract: preview-vfs-read → preview-vfs-response { content | error }
  return `
    (async () => {
      try {
        const ch = new BroadcastChannel('preview-vfs');
        const id = 'dbg-' + Math.random().toString(36).slice(2);
        const p = new Promise((resolve) => {
          const timer = setTimeout(() => { ch.close(); resolve('TIMEOUT — VFS BroadcastChannel not responding'); }, 4000);
          ch.onmessage = (ev) => {
            if (ev.data?.type === 'preview-vfs-response' && ev.data.id === id) {
              clearTimeout(timer); ch.close();
              if (typeof ev.data.error === 'string') resolve('ERROR: ' + ev.data.error);
              else if (ev.data.content !== undefined) resolve(ev.data.content);
              else resolve('(empty response)');
            }
          };
        });
        ch.postMessage({type: 'preview-vfs-read', id, path: '${safePath}', asText: true});
        return await p;
      } catch (e) { return 'ERROR: ' + e.message; }
    })()
  `;
}

async function cmdVfsLs(cdpPort, vfsPath, urlFilter = null) {
  const conn = await attachToTarget(cdpPort, 'page', urlFilter);
  const safePath = vfsPath.replace(/'/g, "\\'");
  const result = await evalIn(conn, vfsReadExpr(safePath));
  console.log(result);
  conn.close();
}

async function cmdVfsCat(cdpPort, vfsPath, urlFilter = null) {
  const conn = await attachToTarget(cdpPort, 'page', urlFilter);
  const safePath = vfsPath.replace(/'/g, "\\'");
  const result = await evalIn(conn, vfsReadExpr(safePath));
  console.log(result);
  conn.close();
}

async function cmdEval(cdpPort, expression, targetFilter, urlFilter = null) {
  const conn = await attachToTarget(cdpPort, targetFilter, urlFilter);
  const r = await conn.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const val =
    r.result?.result?.value ?? r.result?.result?.description ?? r.result?.result ?? r.result;
  console.log(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
  conn.close();
}

async function cmdShell(cdpPort, command, cwd = DEFAULT_CWD, urlFilter = null) {
  const conn = await attachToTarget(cdpPort, 'page', urlFilter);
  // The exec bridge takes only a command string (no protocol change here), so
  // make `cwd` the default by prefixing `cd <cwd> &&` — the same workaround the
  // operator would otherwise type by hand for cwd-sensitive commands (python3).
  const fullCmd = `cd ${shellSingleQuote(cwd)} && ${command}`;
  const safeCmd = fullCmd.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const result = await evalIn(
    conn,
    `(async () => {
      try {
        const handler = globalThis.__slicc_sprinkleManager?.bridge?.execHandler;
        if (!handler) return JSON.stringify({stdout:'',stderr:'shell: sprinkle exec bridge not available\\n',exitCode:127});
        const r = await handler('${safeCmd}');
        return JSON.stringify(r);
      } catch (e) { return JSON.stringify({stdout:'',stderr:'shell: ' + e.message + '\\n',exitCode:1}); }
    })()`
  );
  try {
    const r = JSON.parse(result);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    conn.close();
    process.exit(r.exitCode || 0);
  } catch {
    console.log(result);
    conn.close();
  }
}

async function cmdChat(cdpPort, prompt, urlFilter = null) {
  const conn = await attachToTarget(cdpPort, 'page', urlFilter);
  const result = await evalIn(
    conn,
    `
    (async () => {
      try {
        // Try the orchestrator's prompt method
        const orch = globalThis.__slicc_orchestrator;
        if (orch?.prompt) {
          await orch.prompt(${JSON.stringify(prompt)});
          return 'Prompt sent to orchestrator';
        }
        // Fallback: simulate typing into the chat input
        const input = document.querySelector('.chat-input textarea, [data-chat-input]');
        if (input) {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value').set;
          nativeInputValueSetter.call(input, ${JSON.stringify(prompt)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          // Find and click the send button
          const btn = document.querySelector('.chat-input button[type="submit"], .chat-send-btn');
          if (btn) { btn.click(); return 'Prompt submitted via UI'; }
          return 'Typed into input but no send button found';
        }
        return 'ERROR: No orchestrator or chat input found';
      } catch (e) { return 'ERROR: ' + e.message; }
    })()
  `
  );
  console.log(result);
  conn.close();
}

// ── CLI dispatcher ───────────────────────────────────────────────────────────

async function main() {
  // Global flags (e.g. --url) may precede the subcommand; parse everything up
  // front so `slicc-debug --url localhost:5710 shell "…"` works.
  const { flags, positional } = parseArgv(process.argv.slice(2));
  const command = positional[0];
  const rest = positional.slice(1);

  if (!command || command === '--help' || command === '-h') {
    console.log(`slicc-debug — CDP diagnostic toolkit for SLICC dev harness

Usage: node packages/dev-tools/tools/slicc-debug.mjs [--url <substr>] <command> [args...]

Commands:
  targets                       List all CDP targets (pages, workers)
  logs [--target=page|worker]   Stream console output & errors (Ctrl-C to stop)
  vfs ls <path>                 List VFS directory contents
  vfs cat <path>                Read a VFS file as text
  eval <expression>             Evaluate JS in the page context
  eval --target=worker <expr>   Evaluate JS in the kernel worker
  eval --target=blob <expr>     Evaluate JS in the blob worker (JS/py realm)
  shell <command>               Run a shell command via the sprinkle exec bridge
  chat <prompt>                 Send a prompt to the SLICC agent

Page-target selection (page commands):
  --url <substring>             Pick the page target whose URL contains <substring>
  --url-pattern <regex>         Pick the page target whose URL matches <regex>
                                Default: SLICC_TARGET_URL, then the dev-server
                                port heuristic (localhost:57xx), then first page.

Payload input (eval / shell):
  --file <path>                 Read the payload from a local file ('-' = stdin).
                                Mutually exclusive with an inline payload.

Shell working directory (shell):
  --cwd <path>                  cwd for the shell bridge.
                                Precedence: --cwd > SLICC_CWD > /workspace.

Environment:
  SLICC_CDP_PORT     Override CDP port (default: auto-detect)
  SLICC_BRIDGE_PORT  Override bridge port (default: 5710)
  SLICC_TARGET_URL   Default for --url (page-target URL substring)
  SLICC_CWD          Default shell cwd (below --cwd, above /workspace)`);
    process.exit(0);
  }

  const urlFilter = resolveUrlFilter(flags, process.env);
  const cdpPort = await findCdpPort();

  switch (command) {
    case 'targets':
      await cmdTargets(cdpPort);
      break;

    case 'logs': {
      const target = flags.target || 'page';
      await cmdLogs(cdpPort, target, urlFilter);
      break;
    }

    case 'vfs': {
      const sub = rest[0];
      const path = rest[1];
      if (!sub || !path) {
        console.error('Usage: slicc-debug vfs <ls|cat> <path>');
        process.exit(1);
      }
      if (sub === 'ls') await cmdVfsLs(cdpPort, path, urlFilter);
      else if (sub === 'cat') await cmdVfsCat(cdpPort, path, urlFilter);
      else {
        console.error(`Unknown vfs subcommand: ${sub}`);
        process.exit(1);
      }
      break;
    }

    case 'eval': {
      const target = flags.target || 'page';
      const expr = await readPayload(resolvePayloadSource(flags, rest));
      if (!expr) {
        console.error('Usage: slicc-debug eval <expression>  (or --file <path>)');
        process.exit(1);
      }
      await cmdEval(cdpPort, expr, target, urlFilter);
      break;
    }

    case 'shell': {
      const shellCmd = await readPayload(resolvePayloadSource(flags, rest));
      if (!shellCmd) {
        console.error('Usage: slicc-debug shell <command>  (or --file <path>)');
        process.exit(1);
      }
      await cmdShell(cdpPort, shellCmd, resolveCwd(flags, process.env), urlFilter);
      break;
    }

    case 'chat': {
      const prompt = rest.join(' ');
      if (!prompt) {
        console.error('Usage: slicc-debug chat <prompt>');
        process.exit(1);
      }
      await cmdChat(cdpPort, prompt, urlFilter);
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Run with --help for usage.`);
      process.exit(1);
  }
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}
