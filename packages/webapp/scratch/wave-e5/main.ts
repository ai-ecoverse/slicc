/**
 * Wave E5 — EXIT GATE LIVE harness (THROWAWAY).
 *
 * Drives the *production* `py-realm-worker.ts` against *real*
 * Pyodide 0.29.4 (CDN-loaded inside the worker) and the *real* OPFS
 * subtree the kernel owns at `OPFS-root/slicc-fs/`.
 *
 * Five assertions, all run against REAL Pyodide + REAL OPFS:
 *   E5.1 OPFS_SYNC_FS present on `pyodide.FS.filesystems` after
 *        boot; `/workspace` mount type === the plugin (NOT
 *        mountNativeFS / NODEFS / MEMFS).
 *   E5.2 ZERO `FS.syncfs` calls observed during user code on the
 *        flag-ON path; UTF-8 written from Python reaches OPFS via
 *        flushOpfsRealmMounts (→ createWritable, never syncfs).
 *   E5.3 Byte-fidelity incl. non-UTF8 bytes both directions
 *        (OPFS→Py seed and Py→OPFS binary round-trip).
 *   E5.4 LARGE (>10MB) file written from Python round-trips to
 *        OPFS on the flag-ON path with no artificial cap.
 *   E5.5 Concurrent kernel-side OPFS access (createWritable on the
 *        same subtree) before/after the realm flush completes
 *        without NoModificationAllowedError and yields the
 *        kernel-written bytes (the realm + kernel use the same
 *        async createWritable surface; the buffered SAH provider
 *        only holds in-memory backings — no persistent OPFS locks).
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
const SEED_TEXT = 'WAVE-E5-OPFS-LIVE-SEED\n';
const ROUND_TRIP_TEXT = 'pyodide-wrote-this-utf8-line\nsecond-line\n';
const ROUND_TRIP_BIN = new Uint8Array([0xff, 0x00, 0x80, 0x01, 0xfe, 0x7f, 0xc0, 0x80]);
const LARGE_FILE_SIZE = 12 * 1024 * 1024 + 1357; // ~12.0MB, above the 10MB legacy cap

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
  await writable.write(new Uint8Array(bytes));
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

/**
 * Python payload — installs a syncfs spy at the start of user code,
 * inspects `pyodide_js.FS.filesystems` to confirm OPFS_SYNC_FS is
 * registered and that `/workspace` is mounted via that plugin,
 * writes the UTF-8 / binary / >10MB files, then prints the spy
 * count. We rely on `pyodide_js` (the auto-generated Python module
 * Pyodide exposes for its own JS API) so this works without the
 * worker pre-binding pyodide to globalThis.
 */
const PYTHON_CODE = `
import sys, os, json
import pyodide_js
import js

FS = pyodide_js.FS

_syncfs_calls = [0]
_original_syncfs = FS.syncfs
def _spy_syncfs(*args, **kwargs):
    _syncfs_calls[0] += 1
    return _original_syncfs(*args, **kwargs)
FS.syncfs = _spy_syncfs

filesystems_keys = list(js.Object.keys(FS.filesystems))
print('FS_FILESYSTEMS_KEYS', json.dumps(filesystems_keys))
opfs_plugin = getattr(FS.filesystems, 'OPFS_SYNC_FS', None)
print('HAS_OPFS_SYNC_FS', opfs_plugin is not None)

try:
    node = FS.lookupPath('/workspace').node
    mount_type = node.mount.type
    is_opfs_mount = mount_type == opfs_plugin
except Exception as e:
    is_opfs_mount = False
    print('LOOKUP_ERROR', repr(e))
print('WORKSPACE_MOUNT_IS_OPFS_SYNC_FS', is_opfs_mount)

with open('/workspace/seed.txt', 'rb') as f:
    seed = f.read()
print('SEED_BYTES_LEN', len(seed))
print('SEED_CONTENT', seed.decode('utf-8'), end='')

with open('/workspace/round-trip.txt', 'w', encoding='utf-8') as f:
    f.write(${JSON.stringify(ROUND_TRIP_TEXT)})
with open('/workspace/round-trip.bin', 'wb') as f:
    f.write(bytes([${Array.from(ROUND_TRIP_BIN).join(', ')}]))

LARGE_SIZE = ${LARGE_FILE_SIZE}
buf = bytearray(LARGE_SIZE)
for i in range(LARGE_SIZE):
    buf[i] = (i * 31 + 17) & 0xff
with open('/workspace/large.bin', 'wb') as f:
    f.write(bytes(buf))
print('LARGE_WROTE', LARGE_SIZE)

print('USER_CODE_SYNCFS_COUNT', _syncfs_calls[0])
print('PY_VERSION', sys.version.split()[0])
print('LISTING', sorted(os.listdir('/workspace')))
`;

interface RealmOutcome {
  done?: RealmDoneMsg;
  error?: RealmErrorMsg;
  bootMs: number;
  totalMs: number;
}

async function runRealRealm(init: RealmInitMsg): Promise<RealmOutcome> {
  const worker = new Worker(new URL('../../src/kernel/realm/py-realm-worker.ts', import.meta.url), {
    type: 'module',
  });
  const tStart = performance.now();
  let tBoot = 0;
  try {
    return await new Promise<RealmOutcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('E5 realm timed out after 240s')), 240_000);
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
      tBoot = performance.now() - tStart;
    });
  } finally {
    worker.terminate();
  }
}

async function main(): Promise<void> {
  await wipeOpfsSubdir(OPFS_DB);
  const seedBytes = new TextEncoder().encode(SEED_TEXT);
  await seedOpfsFile(OPFS_DB, ['workspace'], 'seed.txt', seedBytes);

  // Concurrent-access pre-write: write a kernel-side file into the
  // SAME OPFS subtree the realm will mount; the realm must not see
  // it as part of its mount but must also not error on it (the
  // buffered provider preloads `seed.txt` only — `kernel-pre.txt`
  // sits alongside, untouched).
  const kernelPreBytes = new TextEncoder().encode('kernel-pre-realm-write\n');
  await seedOpfsFile(OPFS_DB, ['workspace'], 'kernel-pre.txt', kernelPreBytes);

  const init: RealmInitMsg = {
    type: 'realm-init',
    kind: 'py',
    code: PYTHON_CODE,
    argv: ['python3', '-c', '<e5-harness>'],
    env: {},
    cwd: '/workspace',
    filename: '<e5-live-harness>',
    pyodideIndexURL: resolvePyodideIndexURL(),
    pyodideMountDirs: ['/workspace', '/tmp'],
    opfsMountDbName: OPFS_DB,
  };

  const outcome = await runRealRealm(init);
  const stdout = outcome.done?.stdout ?? '';
  const stderr = outcome.done?.stderr ?? '';

  // --- E5.1 registration -------------------------------------------------
  const hasOpfs = stdout.includes('HAS_OPFS_SYNC_FS True');
  const isMount = stdout.includes('WORKSPACE_MOUNT_IS_OPFS_SYNC_FS True');
  const fsKeysMatch = stdout.match(/FS_FILESYSTEMS_KEYS (\[.*\])/);
  const fsKeys = fsKeysMatch ? (JSON.parse(fsKeysMatch[1]) as string[]) : [];
  if (outcome.done && hasOpfs && isMount && fsKeys.includes('OPFS_SYNC_FS')) {
    pass(
      'E5.1 OPFS_SYNC_FS registered on pyodide.FS.filesystems + /workspace mounted via plugin',
      `FS.filesystems keys=${JSON.stringify(fsKeys)}, mount.type===OPFS_SYNC_FS`
    );
  } else {
    fail(
      'E5.1 OPFS_SYNC_FS registered + /workspace mounted via plugin',
      {
        outcome: outcome.done ? 'done' : 'error',
        error: outcome.error?.message,
        exitCode: outcome.done?.exitCode,
        fsKeys,
        hasOpfs,
        isMount,
        stderr,
        stdoutHead: stdout.slice(0, 600),
      },
      {
        outcome: 'done',
        fsKeys: 'contains OPFS_SYNC_FS',
        hasOpfs: true,
        isMount: true,
      }
    );
  }
  render();

  // --- E5.2 ZERO syncfs during user code + seed pull --------------------
  const syncfsMatch = stdout.match(/USER_CODE_SYNCFS_COUNT (\d+)/);
  const syncfsCount = syncfsMatch ? Number.parseInt(syncfsMatch[1], 10) : -1;
  const seedSeen =
    stdout.includes(`SEED_BYTES_LEN ${seedBytes.length}`) &&
    stdout.includes(`SEED_CONTENT ${SEED_TEXT}`);
  // Pull written UTF-8 file back from real OPFS (proves flush→createWritable
  // landed bytes WITHOUT any syncfs invocation).
  const opfsText = await readOpfsFile(OPFS_DB, ['workspace'], 'round-trip.txt');
  const expectedText = new TextEncoder().encode(ROUND_TRIP_TEXT);
  const utf8Roundtripped = !!opfsText && bytesEqual(opfsText, expectedText);
  if (syncfsCount === 0 && seedSeen && utf8Roundtripped) {
    pass(
      'E5.2 ZERO FS.syncfs during user code + UTF-8 Py→OPFS via OPFS_SYNC_FS flush',
      `user-code syncfs invocations=${syncfsCount}, seed pulled=${seedBytes.length}B, round-trip=${opfsText!.length}B`
    );
  } else {
    fail(
      'E5.2 ZERO FS.syncfs + UTF-8 round-trip',
      { syncfsCount, seedSeen, utf8Roundtripped, opfsTextLen: opfsText?.length ?? null },
      { syncfsCount: 0, seedSeen: true, utf8Roundtripped: true }
    );
  }
  render();

  // --- E5.3 byte fidelity (non-UTF8) -------------------------------------
  const opfsBin = await readOpfsFile(OPFS_DB, ['workspace'], 'round-trip.bin');
  if (opfsBin && bytesEqual(opfsBin, ROUND_TRIP_BIN)) {
    pass(
      'E5.3 BINARY (non-UTF8) byte-fidelity Py→OPFS',
      `len=${opfsBin.length}, first=0x${opfsBin[0].toString(16)}, last=0x${opfsBin[opfsBin.length - 1].toString(16)}`
    );
  } else {
    fail(
      'E5.3 BINARY byte-fidelity',
      opfsBin
        ? { len: opfsBin.length, sample: Array.from(opfsBin) }
        : { read: 'null (missing in OPFS)' },
      { len: ROUND_TRIP_BIN.length, sample: Array.from(ROUND_TRIP_BIN) }
    );
  }
  render();

  // --- E5.4 LARGE file >10MB -------------------------------------------
  const largeWroteSeen = stdout.includes(`LARGE_WROTE ${LARGE_FILE_SIZE}`);
  const opfsLarge = await readOpfsFile(OPFS_DB, ['workspace'], 'large.bin');
  let largeFidelity = false;
  let largeMismatchAt = -1;
  if (opfsLarge && opfsLarge.length === LARGE_FILE_SIZE) {
    largeFidelity = true;
    for (let i = 0; i < LARGE_FILE_SIZE; i++) {
      if (opfsLarge[i] !== ((i * 31 + 17) & 0xff)) {
        largeFidelity = false;
        largeMismatchAt = i;
        break;
      }
    }
  }
  if (largeWroteSeen && largeFidelity) {
    pass(
      'E5.4 >10MB file Py→OPFS round-trip (flag-on path has no 10MB cap)',
      `size=${LARGE_FILE_SIZE}B (${(LARGE_FILE_SIZE / 1024 / 1024).toFixed(2)}MB), full byte-pattern match`
    );
  } else {
    fail(
      'E5.4 >10MB Py→OPFS round-trip',
      {
        largeWroteSeen,
        opfsLargeLen: opfsLarge?.length ?? null,
        largeFidelity,
        largeMismatchAt,
      },
      { largeWroteSeen: true, opfsLargeLen: LARGE_FILE_SIZE, largeFidelity: true }
    );
  }
  render();

  // --- E5.5 concurrent kernel+realm consistency -------------------------
  // Verify the kernel-side pre-realm write survives the realm turn
  // (no clobber by the buffered provider's flush — files outside
  // the prewalk snapshot must NOT be deleted).
  const kernelPreAfter = await readOpfsFile(OPFS_DB, ['workspace'], 'kernel-pre.txt');
  const kernelPreSurvived = !!kernelPreAfter && bytesEqual(kernelPreAfter, kernelPreBytes);
  // Verify the kernel can now write to the SAME file path the realm
  // just flushed — i.e., the buffered provider released its grip
  // and no NoModificationAllowedError is raised.
  let kernelOverwriteOk = false;
  let kernelOverwriteError: string | null = null;
  const kernelPostBytes = new TextEncoder().encode('kernel-overwrote-after-flush\n');
  try {
    await seedOpfsFile(OPFS_DB, ['workspace'], 'round-trip.txt', kernelPostBytes);
    const verify = await readOpfsFile(OPFS_DB, ['workspace'], 'round-trip.txt');
    kernelOverwriteOk = !!verify && bytesEqual(verify, kernelPostBytes);
  } catch (err) {
    kernelOverwriteError = describeErr(err);
  }
  if (kernelPreSurvived && kernelOverwriteOk) {
    pass(
      'E5.5 Concurrent kernel(createWritable)+realm(buffered SAH→createWritable on flush) consistency',
      `pre-realm kernel file survived (${kernelPreBytes.length}B); kernel re-wrote realm-flushed file post-realm with no NoModificationAllowedError`
    );
  } else {
    fail(
      'E5.5 Concurrent kernel+realm consistency',
      { kernelPreSurvived, kernelOverwriteOk, kernelOverwriteError },
      { kernelPreSurvived: true, kernelOverwriteOk: true, kernelOverwriteError: null }
    );
  }
  render();

  publishAndFinish({
    pyodidePackageVersion,
    pyodideIndexURL: init.pyodideIndexURL,
    stdout,
    stderr,
    exitCode: outcome.done?.exitCode ?? null,
    bootMs: outcome.bootMs,
    totalMs: outcome.totalMs,
    userCodeSyncfsCount: syncfsCount,
    fsFilesystemsKeys: fsKeys,
    largeFileSize: LARGE_FILE_SIZE,
  });
}

interface FinishContext {
  pyodidePackageVersion: string;
  pyodideIndexURL: string | undefined;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  bootMs: number;
  totalMs: number;
  userCodeSyncfsCount: number;
  fsFilesystemsKeys: string[];
  largeFileSize: number;
}

function publishAndFinish(ctx: FinishContext): void {
  const allPassed = results.length > 0 && results.every((r) => r.status === 'pass');
  (globalThis as Record<string, unknown>).__waveE5Result = {
    ts: new Date().toISOString(),
    allPassed,
    pyodideVersion: ctx.pyodidePackageVersion,
    pyodideIndexURL: ctx.pyodideIndexURL,
    bootMs: ctx.bootMs,
    totalMs: ctx.totalMs,
    exitCode: ctx.exitCode,
    userCodeSyncfsCount: ctx.userCodeSyncfsCount,
    fsFilesystemsKeys: ctx.fsFilesystemsKeys,
    largeFileSize: ctx.largeFileSize,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    results,
  };
  document.title = allPassed ? 'Wave E5 — PASS' : 'Wave E5 — FAIL';
  render();
}

main().catch((err) => {
  fail('E5 FATAL', describeErr(err), 'no throw', 'main() threw');
  (globalThis as Record<string, unknown>).__waveE5Result = {
    ts: new Date().toISOString(),
    allPassed: false,
    fatal: err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err),
    pyodideVersion: pyodidePackageVersion,
    results,
  };
  document.title = 'Wave E5 — FATAL';
  root.innerHTML = `<pre style="color:#c00">FATAL: ${err instanceof Error ? err.stack : String(err)}</pre>`;
});
