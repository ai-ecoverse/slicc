// Spike 2 worker — sole authoritative OPFS owner.
// Holds sync access handles for test files, runs a hot write loop,
// answers `read`/`stat`/`list` RPC from the page.

const STATE = { root: null, handles: new Map(), writes: 0, lastErr: null, stop: false };

async function getRoot() {
  if (STATE.root) return STATE.root;
  STATE.root = await navigator.storage.getDirectory();
  return STATE.root;
}

async function ensureFile(name) {
  const root = await getRoot();
  return root.getFileHandle(name, { create: true });
}

async function openHandle(name) {
  if (STATE.handles.has(name)) return STATE.handles.get(name);
  const fh = await ensureFile(name);
  // Worker-only API; holds exclusive lock for this file.
  const h = await fh.createSyncAccessHandle();
  STATE.handles.set(name, h);
  return h;
}

function writeAll(handle, bytes) {
  handle.truncate(0);
  handle.write(bytes, { at: 0 });
  handle.flush();
}

function readAll(handle) {
  const size = handle.getSize();
  const buf = new ArrayBuffer(size);
  handle.read(buf, { at: 0 });
  return new Uint8Array(buf);
}

async function startWriteLoop(name, intervalMs) {
  const handle = await openHandle(name);
  const enc = new TextEncoder();
  STATE.stop = false;
  const tick = () => {
    if (STATE.stop) return;
    try {
      const payload = `${STATE.writes}:${Date.now()}\n`;
      // Append-style: read previous, append, write back to simulate
      // a coarse VFS write that must coexist with reads.
      const prev = readAll(handle);
      const next = new Uint8Array(prev.length + payload.length);
      next.set(prev, 0);
      next.set(enc.encode(payload), prev.length);
      writeAll(handle, next);
      STATE.writes++;
    } catch (e) {
      STATE.lastErr = String(e?.message ?? e);
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}

async function rpcRead(name, asText = true) {
  const handle = await openHandle(name);
  const bytes = readAll(handle);
  if (!asText) return { bytes };
  return { text: new TextDecoder().decode(bytes), size: bytes.length };
}

async function rpcList() {
  const root = await getRoot();
  const out = [];
  for await (const [name, entry] of root.entries()) {
    out.push({ name, kind: entry.kind });
  }
  return out;
}

async function rpcStat(name) {
  const handle = await openHandle(name);
  return { size: handle.getSize() };
}

async function rpcWriteOnce(name, text) {
  const handle = await openHandle(name);
  writeAll(handle, new TextEncoder().encode(text));
  return { size: handle.getSize() };
}

async function rpcResetAll() {
  STATE.stop = true;
  for (const h of STATE.handles.values()) {
    try { h.close(); } catch {}
  }
  STATE.handles.clear();
  const root = await getRoot();
  for await (const name of root.keys()) {
    try { await root.removeEntry(name, { recursive: true }); } catch {}
  }
  STATE.writes = 0;
  STATE.lastErr = null;
}

self.onmessage = async (ev) => {
  const { id, op, args } = ev.data;
  try {
    let result;
    switch (op) {
      case 'start-write-loop': result = await startWriteLoop(args.name, args.intervalMs ?? 5); break;
      case 'stop': STATE.stop = true; result = { stopped: true, writes: STATE.writes, lastErr: STATE.lastErr }; break;
      case 'read': result = await rpcRead(args.name, args.asText); break;
      case 'list': result = await rpcList(); break;
      case 'stat': result = await rpcStat(args.name); break;
      case 'write-once': result = await rpcWriteOnce(args.name, args.text); break;
      case 'reset': result = await rpcResetAll(); break;
      case 'status': result = { writes: STATE.writes, lastErr: STATE.lastErr, openHandles: STATE.handles.size }; break;
      default: throw new Error(`unknown op: ${op}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};
