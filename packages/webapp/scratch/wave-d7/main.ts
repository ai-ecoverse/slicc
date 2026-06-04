/**
 * Wave D7 — LIVE EXIT-GATE harness (THROWAWAY).
 *
 * Drives the *production* `py-realm-worker.ts` against the *real*
 * Pyodide 0.29.4 (CDN-loaded inside the worker) and the *real* OPFS
 * substrate the kernel owns at `OPFS-root/slicc-fs/`. Proves the
 * `mountNativeFS` + `FS.syncfs` seam that mocks cannot cover:
 *
 *  1. Pyodide boots and `loadPyodide` returns from the worker.
 *  2. A seed file we wrote into OPFS *before* mount is visible to
 *     Python via `open('/workspace/seed.txt')`.
 *  3. UTF-8 written from Python ends up in OPFS byte-for-byte.
 *  4. Binary bytes (incl. non-UTF8) written from Python end up in
 *     OPFS byte-for-byte.
 */
import { version as pyodidePackageVersion } from 'pyodide/package.json';
import { resolvePyodideIndexURL } from '../../src/kernel/realm/realm-factory.js';
import type {
  RealmDoneMsg,
  RealmErrorMsg,
  RealmInitMsg,
} from '../../src/kernel/realm/realm-types.js';

interface AssertResult {
  name: string;
  status: 'pass' | 'fail';
  detail?: string;
  observed?: unknown;
  expected?: unknown;
}

const results: AssertResult[] = [];
const root = document.getElementById('app')!;
const OPFS_DB = 'slicc-fs';
const SEED_TEXT = 'PYODIDE-OPFS-LIVE-SEED-D7\n';
const ROUND_TRIP_TEXT = 'pyodide-wrote-this-utf8-line\nsecond-line\n';
const ROUND_TRIP_BIN = new Uint8Array([0xff, 0x00, 0x80, 0x01, 0xfe, 0x7f, 0xc0, 0x80, 0x42]);

function pass(name: string, detail?: string): void {
  results.push({ name, status: 'pass', detail });
}
function fail(name: string, observed: unknown, expected: unknown, detail?: string): void {
  results.push({ name, status: 'fail', observed, expected, detail });
}
function describeErr(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
function render(): void {
  const lines = results.map((r) => {
    const icon = r.status === 'pass' ? '✅' : '❌';
    const detail = r.detail ? ` — ${r.detail}` : '';
    const obs =
      r.status === 'fail'
        ? `\n    observed: ${JSON.stringify(r.observed)}\n    expected: ${JSON.stringify(r.expected)}`
        : '';
    return `${icon} ${r.name}${detail}${obs}`;
  });
  root.innerHTML = `<pre>${lines.join('\n')}</pre>`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function wipeOpfsSubdir(name: string): Promise<void> {
  try {
    const dir = await navigator.storage.getDirectory();
    await (
      dir as unknown as { removeEntry: (n: string, o?: { recursive: boolean }) => Promise<void> }
    ).removeEntry(name, { recursive: true });
  } catch {
    /* missing entry is fine */
  }
}

async function seedOpfsFile(
  dbName: string,
  parts: string[],
  filename: string,
  bytes: Uint8Array
): Promise<void> {
  const opfsRoot = await navigator.storage.getDirectory();
  let handle = await opfsRoot.getDirectoryHandle(dbName, { create: true });
  for (const part of parts) {
    handle = await handle.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await handle.getFileHandle(filename, { create: true });
  const writable = await (
    fileHandle as unknown as { createWritable: () => Promise<FileSystemWritableFileStream> }
  ).createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function readOpfsFile(
  dbName: string,
  parts: string[],
  filename: string
): Promise<Uint8Array | null> {
  try {
    const opfsRoot = await navigator.storage.getDirectory();
    let handle = await opfsRoot.getDirectoryHandle(dbName, { create: false });
    for (const part of parts) {
      handle = await handle.getDirectoryHandle(part, { create: false });
    }
    const fileHandle = await handle.getFileHandle(filename, { create: false });
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

const PYTHON_CODE = `
import sys
import os

with open('/workspace/seed.txt', 'rb') as f:
    seed = f.read()
print('SEED_BYTES_LEN', len(seed))
print('SEED_CONTENT', seed.decode('utf-8'), end='')

os.makedirs('/workspace', exist_ok=True)
with open('/workspace/round-trip.txt', 'w', encoding='utf-8') as f:
    f.write(${JSON.stringify(ROUND_TRIP_TEXT)})

with open('/workspace/round-trip.bin', 'wb') as f:
    f.write(bytes([${Array.from(ROUND_TRIP_BIN).join(', ')}]))

print('PY_VERSION', sys.version.split()[0])
print('CWD', os.getcwd())
print('LISTING', sorted(os.listdir('/workspace')))
`;

interface RealmOutcome {
  done?: RealmDoneMsg;
  error?: RealmErrorMsg;
  bootMs: number;
  totalMs: number;
}

async function runRealRealm(init: RealmInitMsg): Promise<RealmOutcome> {
  // Drive the EXACT production worker entry point — same `new Worker(
  // new URL('./py-realm-worker.ts'))` shape `realm-factory.ts` uses,
  // just instantiated from this throwaway harness so the runner can
  // collect the realm-done envelope directly.
  const worker = new Worker(new URL('../../src/kernel/realm/py-realm-worker.ts', import.meta.url), {
    type: 'module',
  });
  const tStart = performance.now();
  let tBoot = 0;
  try {
    return await new Promise<RealmOutcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('D7 realm timed out after 180s')), 180_000);
      worker.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { type?: string };
        if (data?.type === 'realm-done') {
          const done = event.data as RealmDoneMsg;
          clearTimeout(timer);
          resolve({ done, bootMs: tBoot, totalMs: performance.now() - tStart });
        } else if (data?.type === 'realm-error') {
          const errMsg = event.data as RealmErrorMsg;
          clearTimeout(timer);
          resolve({ error: errMsg, bootMs: tBoot, totalMs: performance.now() - tStart });
        }
      });
      worker.addEventListener('error', (ev: ErrorEvent) => {
        clearTimeout(timer);
        reject(new Error(`Worker error: ${ev.message}`));
      });
      worker.postMessage(init);
      // Boot time is wall-clock to first message; recorded for the
      // transcript so a slow CDN load is visible.
      tBoot = performance.now() - tStart;
    });
  } finally {
    worker.terminate();
  }
}

async function main(): Promise<void> {
  // 1) Clean OPFS slate
  await wipeOpfsSubdir(OPFS_DB);

  // 2) Seed real OPFS BEFORE the realm boots so the mount has
  // something to pull through `syncfs(true)`.
  const seedBytes = new TextEncoder().encode(SEED_TEXT);
  await seedOpfsFile(OPFS_DB, ['workspace'], 'seed.txt', seedBytes);

  // 3) Build the init that mirrors what `python-command` would send
  // when `slicc_opfs_vfs === 'opfs'`.
  const init: RealmInitMsg = {
    type: 'realm-init',
    kind: 'py',
    code: PYTHON_CODE,
    argv: ['python3', '-c', '<d7-harness>'],
    env: {},
    cwd: '/workspace',
    filename: '<d7-live-harness>',
    pyodideIndexURL: resolvePyodideIndexURL(),
    pyodideMountDirs: ['/workspace', '/tmp'],
    opfsMountDbName: OPFS_DB,
  };

  const outcome = await runRealRealm(init);

  // Assertion 1: Realm boot succeeded (Pyodide loaded, code ran, exit=0).
  if (outcome.done && outcome.done.exitCode === 0) {
    pass(
      'D7.1 LIVE Pyodide boot + exec (exit=0)',
      `exit=${outcome.done.exitCode}, boot=${outcome.bootMs.toFixed(0)}ms, total=${outcome.totalMs.toFixed(0)}ms, stderr=${JSON.stringify(outcome.done.stderr)}`
    );
  } else {
    fail(
      'D7.1 LIVE Pyodide boot + exec',
      {
        kind: outcome.error ? 'realm-error' : 'realm-done',
        error: outcome.error?.message,
        exitCode: outcome.done?.exitCode,
        stderr: outcome.done?.stderr,
        stdout: outcome.done?.stdout,
      },
      { kind: 'realm-done', exitCode: 0 }
    );
  }
  render();

  const stdout = outcome.done?.stdout ?? '';

  // Assertion 2: SEED VISIBLE — Python read the OPFS-seeded bytes via
  // the native mount.
  const seenSeedMarker = stdout.includes(`SEED_CONTENT ${SEED_TEXT}`);
  const seenSeedLen = stdout.includes(`SEED_BYTES_LEN ${seedBytes.length}`);
  if (seenSeedMarker && seenSeedLen) {
    pass(
      'D7.2 OPFS→Pyodide seed visible inside Python (mountNativeFS + syncfs(true))',
      `bytes=${seedBytes.length}, text=${JSON.stringify(SEED_TEXT)}`
    );
  } else {
    fail(
      'D7.2 OPFS→Pyodide seed visible inside Python',
      {
        seenSeedLen,
        seenSeedMarker,
        stdoutHead: stdout.slice(0, 400),
      },
      {
        seenSeedLen: true,
        seenSeedMarker: true,
      }
    );
  }
  render();

  // Assertion 3: Round-trip TEXT — Python wrote `/workspace/round-trip.txt`
  // and we read it back through OPFS directly (NOT via the realm).
  const opfsText = await readOpfsFile(OPFS_DB, ['workspace'], 'round-trip.txt');
  const expectedText = new TextEncoder().encode(ROUND_TRIP_TEXT);
  if (opfsText && bytesEqual(opfsText, expectedText)) {
    pass(
      'D7.3 Pyodide→OPFS UTF-8 round-trip (syncfs(false) write-back)',
      `bytes=${opfsText.length}, text=${JSON.stringify(new TextDecoder().decode(opfsText))}`
    );
  } else {
    fail(
      'D7.3 Pyodide→OPFS UTF-8 round-trip',
      opfsText
        ? {
            length: opfsText.length,
            text: new TextDecoder().decode(opfsText),
          }
        : { read: 'null (file missing in OPFS)' },
      { length: expectedText.length, text: ROUND_TRIP_TEXT }
    );
  }
  render();

  // Assertion 4: Round-trip BINARY — Python wrote bytes containing
  // 0xFF / 0x00 / non-UTF8 sequences; OPFS must return them byte-for-byte.
  const opfsBin = await readOpfsFile(OPFS_DB, ['workspace'], 'round-trip.bin');
  if (opfsBin && bytesEqual(opfsBin, ROUND_TRIP_BIN)) {
    pass(
      'D7.4 Pyodide→OPFS BINARY round-trip (non-UTF8 bytes byte-identical)',
      `length=${opfsBin.length}, first=0x${opfsBin[0].toString(16)}, last=0x${opfsBin[opfsBin.length - 1].toString(16)}`
    );
  } else {
    fail(
      'D7.4 Pyodide→OPFS BINARY round-trip',
      opfsBin
        ? { length: opfsBin.length, sample: Array.from(opfsBin) }
        : { read: 'null (file missing in OPFS)' },
      { length: ROUND_TRIP_BIN.length, sample: Array.from(ROUND_TRIP_BIN) }
    );
  }
  render();

  publishAndFinish({
    pyodidePackageVersion,
    pyodideIndexURL: init.pyodideIndexURL,
    stdout,
    bootMs: outcome.bootMs,
    totalMs: outcome.totalMs,
  });
}

interface FinishContext {
  pyodidePackageVersion: string;
  pyodideIndexURL: string | undefined;
  stdout: string;
  bootMs: number;
  totalMs: number;
}

function publishAndFinish(ctx: FinishContext): void {
  const allPassed = results.length > 0 && results.every((r) => r.status === 'pass');
  (globalThis as Record<string, unknown>).__waveD7Result = {
    ts: new Date().toISOString(),
    allPassed,
    pyodideVersion: ctx.pyodidePackageVersion,
    pyodideIndexURL: ctx.pyodideIndexURL,
    bootMs: ctx.bootMs,
    totalMs: ctx.totalMs,
    stdout: ctx.stdout,
    results,
  };
  document.title = allPassed ? 'Wave D7 — PASS' : 'Wave D7 — FAIL';
  render();
}

main().catch((err) => {
  fail('D7 FATAL', describeErr(err), 'no throw', 'main() threw');
  (globalThis as Record<string, unknown>).__waveD7Result = {
    ts: new Date().toISOString(),
    allPassed: false,
    fatal: err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err),
    pyodideVersion: pyodidePackageVersion,
    results,
  };
  document.title = 'Wave D7 — FATAL';
  root.innerHTML = `<pre style="color:#c00">FATAL: ${err instanceof Error ? err.stack : String(err)}</pre>`;
});
