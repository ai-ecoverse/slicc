// Driver page for Spike 3. Spawns the worker, displays logs, then
// reads OPFS directly from the page to prove cross-visibility.

const logEl = document.getElementById('log');
const opfsEl = document.getElementById('opfs');

function log(msg) {
  logEl.textContent += `\n${msg}`;
}

async function readOpfsDirect(rootName) {
  const lines = [];
  try {
    const root = await navigator.storage.getDirectory();
    const sub = await root.getDirectoryHandle(rootName, { create: false });
    for await (const [name, handle] of sub.entries()) {
      if (handle.kind === 'file') {
        const f = await handle.getFile();
        const bytes = new Uint8Array(await f.arrayBuffer());
        const preview = new TextDecoder().decode(bytes.slice(0, 200));
        lines.push(
          `[file]  ${name}  (${f.size}B, mtime=${new Date(f.lastModified).toISOString()})`
        );
        lines.push(`        first200=${JSON.stringify(preview)}`);
      } else {
        lines.push(`[dir]   ${name}/`);
      }
    }
  } catch (err) {
    lines.push(`(opfs read failed: ${err.message})`);
  }
  return lines.join('\n');
}

async function run(variant) {
  logEl.textContent = `(running ${variant}…)`;
  opfsEl.textContent = '(waiting for worker)';
  const worker = new Worker(new URL('./prototype-worker.js', import.meta.url), {
    type: 'module',
  });
  const done = new Promise((resolve) => {
    worker.addEventListener('message', (e) => {
      const { type, payload } = e.data || {};
      if (type === 'log') log(payload);
      if (type === 'done') resolve(payload);
    });
  });
  worker.postMessage({ type: 'run', variant });
  const result = await done;
  worker.terminate();
  log(`\n=== worker result: ${JSON.stringify(result, null, 2)}`);
  opfsEl.textContent = await readOpfsDirect('pyfs-mount');
}

document.getElementById('run-a').addEventListener('click', () => run('a'));
document.getElementById('run-c').addEventListener('click', () => run('c'));
document.getElementById('wipe').addEventListener('click', async () => {
  const root = await navigator.storage.getDirectory();
  for await (const [name] of root.entries()) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch (err) {
      log(`wipe: ${name} → ${err.message}`);
    }
  }
  log('OPFS wiped.');
  opfsEl.textContent = '(wiped)';
});
