#!/usr/bin/env node
import http from 'http';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--cdp-port') flags.cdpPort = parseInt(args[++i], 10);
  else if (args[i] === '--server-port') flags.serverPort = parseInt(args[++i], 10);
  else if (args[i] === '--clear') flags.clear = true;
  else if (args[i] === '--read-last') flags.readLast = true;
  else if (args[i] === '--script') flags.script = args[++i];
  else if (args[i] === '--timeout') flags.timeout = parseInt(args[++i], 10);
  else positional.push(args[i]);
}

const CDP_PORT = flags.cdpPort || 9222;
const SERVER_PORT = flags.serverPort || 5710;
const TIMEOUT = (flags.timeout || 120) * 1000;
const prompt = positional.join(' ');

if (!prompt && !flags.readLast) {
  console.error('Usage: node tools/slicc-prompt.mjs "your prompt" [--script "cmd"] [--clear] [--timeout 120]');
  console.error('       node tools/slicc-prompt.mjs --read-last');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'} for ${url}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Failed to parse JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });
    req.on('error', reject);
  });
}

async function getPageTarget(cdpPort, serverPort) {
  const targets = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const needles = [`localhost:${serverPort}`, `127.0.0.1:${serverPort}`, 'localhost', '127.0.0.1'];
  const target = targets.find(
    (entry) => entry.type === 'page' && needles.some((needle) => String(entry.url || '').includes(needle))
  );
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No page target found for localhost:${serverPort} on CDP port ${cdpPort}`);
  }
  return target;
}

async function connectCDP(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || 'Unknown CDP error'));
    else resolve(msg.result);
  });
  ws.on('close', () => rejectPending(new Error('CDP connection closed')));
  ws.on('error', (error) => rejectPending(error));

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      });
    });

  await send('Runtime.enable');

  return {
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        const description = result.result?.description || result.exceptionDetails.text || 'Runtime.evaluate failed';
        throw new Error(description);
      }
      return result.result?.value;
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    },
  };
}

async function waitForChatReady(cdp, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ready = await cdp.evaluate(`(() => !!document.querySelector('textarea.chat__textarea'))()`);
      if (ready) return;
    } catch {
      // Navigation can temporarily destroy the execution context.
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for SLICC chat UI to become ready');
}

async function getAssistantState(cdp) {
  return cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('.msg-group[data-msg-id] .msg--assistant .msg__content')];
    const last = items.at(-1);
    const text = last?.innerText?.trim() || null;
    const html = last?.innerHTML?.trim() || null;
    return {
      count: items.length,
      text: text || html || null,
    };
  })()`);
}

async function readLastMessage(cdp) {
  const state = await getAssistantState(cdp);
  return state.text;
}

async function clearChat(cdp) {
  await cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Clear Chat"]');
    if (!button) throw new Error('Clear Chat button not found');
    button.click();
    return true;
  })()`);
  await waitForChatReady(cdp, 20000);
}

async function submitPrompt(cdp, text) {
  return cdp.evaluate(`(() => {
    const textarea = document.querySelector('textarea.chat__textarea');
    const sendBtn = document.querySelector('button.chat__send-btn');
    if (!textarea) throw new Error('Chat textarea not found');
    if (!sendBtn) throw new Error('Send button not found');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Native textarea value setter not found');
    setter.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    sendBtn.click();
    return true;
  })()`);
}

async function waitForCompletion(cdp, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const state = await cdp.evaluate(`(() => {
        const sendBtn = document.querySelector('button.chat__send-btn');
        const stopBtn = document.querySelector('button.chat__stop-btn');
        const sendVisible = !!sendBtn && getComputedStyle(sendBtn).display !== 'none' && sendBtn.offsetParent !== null;
        const stopVisible = !!stopBtn && getComputedStyle(stopBtn).display !== 'none' && stopBtn.offsetParent !== null;
        return {
          sendVisible,
          sendEnabled: !!sendBtn && !sendBtn.disabled,
          stopVisible,
          streaming: !!document.querySelector('.streaming-cursor'),
        };
      })()`);

      if (!state.stopVisible && !state.streaming && state.sendVisible && state.sendEnabled) return;
    } catch {
      // Ignore transient evaluation failures and keep polling.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for prompt completion after ${Math.round(timeout / 1000)}s`);
}

async function runTurn(cdp, text) {
  await waitForChatReady(cdp);
  await submitPrompt(cdp, text);
  await waitForCompletion(cdp, TIMEOUT);
  return readLastMessage(cdp);
}

async function main() {
  const started = Date.now();
  let cdp;
  try {
    const target = await getPageTarget(CDP_PORT, SERVER_PORT);
    cdp = await connectCDP(target.webSocketDebuggerUrl);
    await waitForChatReady(cdp);

    let response = null;
    let scriptOutput = undefined;

    if (flags.clear) {
      await clearChat(cdp);
    }

    if (flags.readLast) {
      response = await readLastMessage(cdp);
    } else {
      response = await runTurn(cdp, prompt);
      if (flags.script) {
        scriptOutput = await runTurn(cdp, flags.script);
      }
    }

    console.log(
      JSON.stringify(
        {
          prompt: flags.readLast ? null : prompt,
          response,
          ...(scriptOutput !== undefined ? { scriptOutput } : {}),
          durationMs: Date.now() - started,
          success: true,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          prompt: flags.readLast ? null : prompt || null,
          response: null,
          durationMs: Date.now() - started,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    cdp?.close();
  }
}

await main();