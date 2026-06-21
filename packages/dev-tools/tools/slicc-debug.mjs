#!/usr/bin/env node
/**
 * slicc-debug.mjs — CDP diagnostic toolkit for SLICC standalone dev harness.
 *
 * Usage:
 *   node packages/dev-tools/tools/slicc-debug.mjs <command> [args...]
 *
 * Commands:
 *   targets                     List all CDP targets (pages, workers, etc.)
 *   logs [--target=page|worker] Stream console output & errors (Ctrl-C to stop)
 *   vfs ls <path>               List VFS directory contents
 *   vfs cat <path>              Read a VFS file (text)
 *   eval <expression>           Evaluate JS in the page context
 *   chat <prompt>               Send a prompt to the SLICC agent
 *
 * Environment:
 *   SLICC_CDP_PORT   Override CDP port (default: auto-detect from thin-bridge on :5710)
 *   SLICC_BRIDGE_PORT Override bridge port (default: 5710)
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const BRIDGE_PORT = process.env.SLICC_BRIDGE_PORT || '5710';

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

async function attachToTarget(cdpPort, type = 'page') {
  const targets = await getTargets(cdpPort);
  let target;
  if (type === 'worker' || type === 'kernel') {
    target = targets.find((t) => t.type === 'worker' && t.url.includes('kernel-worker'));
  } else {
    target = targets.find((t) => t.type === 'page');
  }
  if (!target) throw new Error(`No ${type} target found`);
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

async function cmdLogs(cdpPort, targetFilter) {
  const targets = await getTargets(cdpPort);
  let target;
  if (targetFilter === 'worker') {
    target = targets.find((t) => t.type === 'worker' && t.url.includes('kernel-worker'));
  } else {
    target = targets.find((t) => t.type === 'page');
  }
  if (!target) throw new Error(`No ${targetFilter || 'page'} target found`);
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

async function cmdVfsLs(cdpPort, vfsPath) {
  const conn = await attachToTarget(cdpPort, 'page');
  const safePath = vfsPath.replace(/'/g, "\\'");
  const result = await evalIn(conn, vfsReadExpr(safePath));
  console.log(result);
  conn.close();
}

async function cmdVfsCat(cdpPort, vfsPath) {
  const conn = await attachToTarget(cdpPort, 'page');
  const safePath = vfsPath.replace(/'/g, "\\'");
  const result = await evalIn(conn, vfsReadExpr(safePath));
  console.log(result);
  conn.close();
}

async function cmdEval(cdpPort, expression, targetFilter) {
  const targets = await getTargets(cdpPort);
  let target;
  if (targetFilter === 'worker') {
    target = targets.find((t) => t.type === 'worker' && t.url.includes('kernel-worker'));
  } else {
    target = targets.find((t) => t.type === 'page');
  }
  if (!target) throw new Error(`No ${targetFilter || 'page'} target found`);
  const conn = await connectTarget(target.webSocketDebuggerUrl);
  await conn.send('Runtime.enable');
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

async function cmdShell(cdpPort, command) {
  const conn = await attachToTarget(cdpPort, 'page');
  const safeCmd = command.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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

async function cmdChat(cdpPort, prompt) {
  const conn = await attachToTarget(cdpPort, 'page');
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
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`slicc-debug — CDP diagnostic toolkit for SLICC dev harness

Usage: node packages/dev-tools/tools/slicc-debug.mjs <command> [args...]

Commands:
  targets                       List all CDP targets (pages, workers)
  logs [--target=page|worker]   Stream console output & errors (Ctrl-C to stop)
  vfs ls <path>                 List VFS directory contents
  vfs cat <path>                Read a VFS file as text
  eval <expression>             Evaluate JS in the page context
  eval --target=worker <expr>   Evaluate JS in the kernel worker
  shell <command>               Run a shell command in the SLICC terminal
  chat <prompt>                 Send a prompt to the SLICC agent

Environment:
  SLICC_CDP_PORT     Override CDP port (default: auto-detect)
  SLICC_BRIDGE_PORT  Override bridge port (default: 5710)`);
    process.exit(0);
  }

  const cdpPort = await findCdpPort();

  switch (command) {
    case 'targets':
      await cmdTargets(cdpPort);
      break;

    case 'logs': {
      const targetFlag = args.find((a) => a.startsWith('--target='));
      const target = targetFlag ? targetFlag.split('=')[1] : 'page';
      await cmdLogs(cdpPort, target);
      break;
    }

    case 'vfs': {
      const sub = args[1];
      const path = args[2];
      if (!sub || !path) {
        console.error('Usage: slicc-debug vfs <ls|cat> <path>');
        process.exit(1);
      }
      if (sub === 'ls') await cmdVfsLs(cdpPort, path);
      else if (sub === 'cat') await cmdVfsCat(cdpPort, path);
      else {
        console.error(`Unknown vfs subcommand: ${sub}`);
        process.exit(1);
      }
      break;
    }

    case 'eval': {
      const targetFlag = args.find((a) => a.startsWith('--target='));
      const target = targetFlag ? targetFlag.split('=')[1] : 'page';
      const expr = args
        .filter((a) => !a.startsWith('--'))
        .slice(1)
        .join(' ');
      if (!expr) {
        console.error('Usage: slicc-debug eval <expression>');
        process.exit(1);
      }
      await cmdEval(cdpPort, expr, target);
      break;
    }

    case 'shell': {
      const shellCmd = args.slice(1).join(' ');
      if (!shellCmd) {
        console.error('Usage: slicc-debug shell <command>');
        process.exit(1);
      }
      await cmdShell(cdpPort, shellCmd);
      break;
    }

    case 'chat': {
      const prompt = args.slice(1).join(' ');
      if (!prompt) {
        console.error('Usage: slicc-debug chat <prompt>');
        process.exit(1);
      }
      await cmdChat(cdpPort, prompt);
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Run with --help for usage.`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
