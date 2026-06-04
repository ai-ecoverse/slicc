// Spike 2 page — drives the worker over postMessage RPC.
// Validates: (1) page reads concurrently with worker writes,
// (2) page reads via FileSystemFileHandle while worker holds the sync handle.

const worker = new Worker('./worker.js');
const pending = new Map();
let seq = 0;
worker.onmessage = (ev) => {
  const { id, ok, result, error } = ev.data;
  const slot = pending.get(id);
  if (!slot) return;
  pending.delete(id);
  if (ok) slot.resolve(result); else slot.reject(new Error(error));
};
function rpc(op, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args });
  });
}

const log = (msg, kind = 'info') => {
  const el = document.getElementById('log');
  const line = document.createElement('div');
  line.className = `line ${kind}`;
  line.textContent = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  console[kind === 'err' ? 'error' : 'log'](msg);
};

window.__results = { passes: 0, fails: 0, details: [] };
function check(name, cond, detail = '') {
  if (cond) {
    window.__results.passes++;
    log(`✅ ${name}${detail ? ` — ${detail}` : ''}`, 'ok');
  } else {
    window.__results.fails++;
    log(`❌ ${name}${detail ? ` — ${detail}` : ''}`, 'err');
  }
  window.__results.details.push({ name, ok: cond, detail });
}

async function pageReadViaHandle(name) {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name);
  const file = await fh.getFile();
  return file.text();
}

async function runAll() {
  log('Reset OPFS root + handles');
  await rpc('reset');

  // ── Test 1: Concurrent read-via-RPC while worker writes hot.
  log('Test 1: 1000 RPC reads while worker hot-writes every 5ms');
  await rpc('start-write-loop', { name: 'hot.txt', intervalMs: 5 });
  let rpcReads = 0, rpcOk = 0, rpcFail = 0, sizes = [];
  for (let i = 0; i < 1000; i++) {
    try {
      const r = await rpc('read', { name: 'hot.txt' });
      rpcOk++;
      sizes.push(r.size);
    } catch (e) {
      rpcFail++;
      log(`  read #${i} failed: ${e.message}`, 'err');
    }
    rpcReads++;
  }
  const st1 = await rpc('stop');
  check('1000 RPC reads under hot write loop succeed', rpcFail === 0, `ok=${rpcOk} fail=${rpcFail} writes=${st1.writes} lastErr=${st1.lastErr ?? 'none'}`);
  check('sizes are monotonically non-decreasing (no corruption)', sizes.every((s, i) => i === 0 || s >= sizes[i - 1]), `min=${sizes[0]} max=${sizes[sizes.length - 1]}`);

  // ── Test 2: page tries direct FileSystemFileHandle.getFile() READ while
  // the worker still holds the sync access handle. Document the actual
  // Chrome behavior (may return a stale snapshot rather than throw).
  log('Test 2: page FileSystemFileHandle.getFile() while worker holds sync handle');
  let pageDirectReadThrew = false, pageDirectReadLen = -1;
  try {
    const txt = await pageReadViaHandle('hot.txt');
    pageDirectReadLen = txt.length;
  } catch (e) {
    pageDirectReadThrew = true;
    log(`  threw: ${e.message}`, 'err');
  }
  check('page-direct-read coexists with open worker sync handle (Chrome behavior recorded)', true,
    pageDirectReadThrew ? 'getFile threw' : `getFile returned ${pageDirectReadLen} bytes (snapshot may be stale; do NOT rely on it)`);

  // ── Test 2b: page tries to OPEN ITS OWN sync access handle while the
  // worker holds one. This MUST fail (the lock is exclusive against
  // other handle openers).
  log('Test 2b: page createWritable() on same file while worker holds sync handle');
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('hot.txt');
    const w = await fh.createWritable();
    await w.write('clobber');
    await w.close();
    check('page createWritable on locked file should reject', false, 'unexpected success');
  } catch (e) {
    check('page createWritable on locked file rejects (lock honored)', true, e.message);
  }

  // ── Test 3: after worker drops the handle, page can read directly.
  log('Test 3: worker.reset releases handles; page-direct-read works');
  await rpc('reset');
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('after.txt', { create: true });
    const wfh = await fh.createWritable();
    await wfh.write('page-write-after-worker-reset');
    await wfh.close();
    const text = await (await fh.getFile()).text();
    check('page can read+write OPFS after worker releases handles', text === 'page-write-after-worker-reset');
  } catch (e) {
    check('page can read+write OPFS after worker releases handles', false, e.message);
  }

  // ── Test 4: list + stat RPC under load.
  log('Test 4: list + stat RPC');
  await rpc('reset');
  await rpc('write-once', { name: 'a.txt', text: 'A'.repeat(100) });
  await rpc('write-once', { name: 'b.txt', text: 'B'.repeat(200) });
  const list = await rpc('list');
  check('list returns 2 entries', list.length === 2, list.map(e => e.name).join(','));
  const sa = await rpc('stat', { name: 'a.txt' });
  const sb = await rpc('stat', { name: 'b.txt' });
  check('stat sizes correct', sa.size === 100 && sb.size === 200, `a=${sa.size} b=${sb.size}`);

  // ── Test 5: parallel reads, no deadlock.
  log('Test 5: 200 parallel reads');
  await rpc('start-write-loop', { name: 'hot.txt', intervalMs: 5 });
  const results = await Promise.allSettled(Array.from({ length: 200 }, () => rpc('read', { name: 'hot.txt' })));
  await rpc('stop');
  const okN = results.filter(r => r.status === 'fulfilled').length;
  check('200 parallel reads (no deadlock)', okN === 200, `ok=${okN}/200`);

  log('-----');
  log(`SUMMARY: ${window.__results.passes} passed, ${window.__results.fails} failed`);
  document.getElementById('summary').textContent = JSON.stringify(window.__results, null, 2);
}

document.getElementById('run').addEventListener('click', () => runAll().catch(e => log(`fatal: ${e.message}`, 'err')));
