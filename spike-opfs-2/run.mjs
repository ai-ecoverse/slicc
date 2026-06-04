// Drive the SLICC dev Chrome at CDP :9222 to run the prototype.
import { WebSocket } from 'ws';

const URL = 'http://127.0.0.1:8765/index.html';
const meta = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(meta.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    const slot = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  }
});
await new Promise((r) => ws.once('open', r));
const send = (method, params, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send('Target.createTarget', { url: URL });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);

// Wait for page to be fully loaded
async function waitForReady() {
  for (let i = 0; i < 50; i++) {
    const r = await send(
      'Runtime.evaluate',
      { expression: 'document.readyState', returnByValue: true },
      sessionId
    );
    if (r.result.value === 'complete') return;
    await new Promise((res) => setTimeout(res, 100));
  }
}
await waitForReady();
console.log('page ready');

const headers = await send(
  'Runtime.evaluate',
  { expression: 'navigator.userAgent', returnByValue: true },
  sessionId
);
console.log('UA:', headers.result.value);

// Kick off the test and wait for completion (poll window.__results)
await send(
  'Runtime.evaluate',
  { expression: 'document.getElementById("run").click()', returnByValue: true },
  sessionId
);

let result = null;
for (let i = 0; i < 600; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const r = await send(
    'Runtime.evaluate',
    {
      expression:
        'JSON.stringify({ done: !!(window.__results && document.getElementById("summary").textContent.startsWith("{")), results: window.__results || null })',
      returnByValue: true,
    },
    sessionId
  );
  const v = JSON.parse(r.result.value);
  if (v.done && v.results) {
    result = v.results;
    break;
  }
}
console.log('---FINAL---');
console.log(JSON.stringify(result, null, 2));

await send('Target.closeTarget', { targetId });
ws.close();
process.exit(result && result.fails === 0 ? 0 : 1);
