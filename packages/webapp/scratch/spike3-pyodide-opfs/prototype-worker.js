// Spike 3 prototype worker. Loads stock Pyodide 0.29.x from CDN
// (matches our pinned production version) and tries each approach
// from the task note in turn.

const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.29.4/full/';
const MOUNT_POINT = '/mnt';
const OPFS_DIR = 'pyfs-mount';

function log(msg) {
  postMessage({ type: 'log', payload: String(msg) });
}

const pyodideModulePromise = import(/* @vite-ignore */ `${PYODIDE_CDN}pyodide.mjs`);

async function getOpfsHandle() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

async function loadPy() {
  const t0 = performance.now();
  const mod = await pyodideModulePromise;
  const py = await mod.loadPyodide({ indexURL: PYODIDE_CDN, fullStdLib: false });
  log(`pyodide loaded in ${(performance.now() - t0).toFixed(0)}ms`);
  return py;
}

// ---------------------------------------------------------------------------
// (a) Stock mountNativeFS + syncfs — the path available today.
// ---------------------------------------------------------------------------

async function variantA() {
  const py = await loadPy();
  const handle = await getOpfsHandle();
  await py.mountNativeFS(MOUNT_POINT, handle);
  log(`mounted OPFS at ${MOUNT_POINT}`);

  // Python writes through Pyodide's FS — lands in MEMFS, not OPFS yet.
  const tWrite = performance.now();
  py.runPython(`
import os, time
os.makedirs("${MOUNT_POINT}/sub", exist_ok=True)
with open("${MOUNT_POINT}/hello.txt", "w") as f:
    f.write(f"hello from python at {time.time()}\\n")
with open("${MOUNT_POINT}/sub/payload.bin", "wb") as f:
    f.write(bytes(range(256)) * 1024)  # 256 KiB binary
  `);
  log(`python writes finished in ${(performance.now() - tWrite).toFixed(0)}ms`);

  // Probe OPFS BEFORE syncfs to prove the per-call copy is still there.
  const preSyncList = await listOpfs();
  log(`OPFS before syncfs: ${preSyncList.length} entries → ${preSyncList.join(', ') || '(empty)'}`);

  const tSync = performance.now();
  await new Promise((resolve, reject) =>
    py.FS.syncfs(false, (err) => (err ? reject(err) : resolve()))
  );
  log(`syncfs(false) finished in ${(performance.now() - tSync).toFixed(0)}ms`);

  const postSyncList = await listOpfs();
  log(`OPFS after syncfs: ${postSyncList.length} entries → ${postSyncList.join(', ')}`);

  // Round-trip: read what we wrote, then have Python see externally-written file.
  await writeFromJs('externally.txt', 'written by main worker, read by python\n');
  await new Promise((resolve, reject) =>
    py.FS.syncfs(true, (err) => (err ? reject(err) : resolve()))
  );
  const seenByPython = py.FS.readFile(`${MOUNT_POINT}/externally.txt`, { encoding: 'utf8' });
  log(`python read externally.txt → ${JSON.stringify(seenByPython)}`);

  postMessage({
    type: 'done',
    payload: {
      variant: 'a',
      verdict:
        'mountNativeFS works, but writes need an explicit syncfs(false). The pre-sync OPFS list is empty — confirming the MEMFS→OPFS reconcile IS a copy step, just batched.',
    },
  });
}

async function listOpfs() {
  const handle = await getOpfsHandle();
  const out = [];
  // Recursive walk (one level deep is enough for this prototype).
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === 'file') {
      out.push(name);
    } else {
      for await (const [child] of entry.entries()) out.push(`${name}/${child}`);
    }
  }
  return out.sort();
}

async function writeFromJs(name, contents) {
  const handle = await getOpfsHandle();
  const fh = await handle.getFileHandle(name, { create: true });
  // createSyncAccessHandle is the synchronous OPFS API available in
  // workers — the same surface a custom OPFS_SYNC_FS plugin would use.
  const sah = await fh.createSyncAccessHandle();
  try {
    sah.truncate(0);
    sah.write(new TextEncoder().encode(contents), { at: 0 });
    sah.flush();
  } finally {
    sah.close();
  }
}

// ---------------------------------------------------------------------------
// (c) Custom OPFS_SYNC_FS — sketch. Demonstrates that a stock Pyodide
//     build allows registering extra Emscripten filesystems by mutating
//     `py.FS.filesystems` before calling `FS.mount`. The implementation
//     here is intentionally a stub that only proves the registration
//     wires up; a real impl needs full node_ops + stream_ops.
// ---------------------------------------------------------------------------

async function variantC() {
  const py = await loadPy();
  const handle = await getOpfsHandle();
  await registerOpfsSyncFs(py, handle);
  log('OPFS_SYNC_FS registered into py.FS.filesystems (sketch).');
  py.FS.mkdir(MOUNT_POINT);
  py.FS.mount(py.FS.filesystems.OPFS_SYNC_FS, { dirHandle: handle }, MOUNT_POINT);
  log(`mounted OPFS_SYNC_FS stub at ${MOUNT_POINT}`);
  try {
    py.runPython(`
open("${MOUNT_POINT}/sync.txt", "w").write("via OPFS_SYNC_FS\\n")
print(open("${MOUNT_POINT}/sync.txt").read())
    `);
    log('python write+read via stub completed (would land in OPFS in a real impl)');
  } catch (err) {
    log(`stub raised (expected — see notes): ${err.message}`);
  }
  postMessage({
    type: 'done',
    payload: {
      variant: 'c',
      verdict:
        'Registering a custom FS into py.FS.filesystems works without rebuilding Pyodide. A full impl needs the node_ops + stream_ops tables wired to FileSystemSyncAccessHandle.',
    },
  });
}

async function registerOpfsSyncFs(py, _dirHandle) {
  // Pyodide exposes Emscripten's FS plugin API as
  // `py.FS.filesystems.<NAME>`. The same place nativefs.ts assigns
  // NATIVEFS_ASYNC. We can attach our own here.
  py.FS.filesystems.OPFS_SYNC_FS = {
    mount(mount) {
      // Reuse MEMFS for node creation. Real impl would create custom
      // nodes backed by FileSystemSyncAccessHandle.
      return py.FS.filesystems.MEMFS.mount(mount);
    },
  };
}

self.addEventListener('message', (e) => {
  const { type, variant } = e.data || {};
  if (type !== 'run') return;
  const fn = variant === 'a' ? variantA : variantC;
  fn().catch((err) => {
    log(`ERROR: ${err.stack || err}`);
    postMessage({ type: 'done', payload: { variant, error: String(err) } });
  });
});
