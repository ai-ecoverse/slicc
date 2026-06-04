/**
 * Wave C6 — EXIT GATE harness (THROWAWAY).
 *
 * Seeds the legacy `slicc-fs` LightningFS IDB with a known fixture
 * (nested dirs, a symlink with a known target, a binary file with
 * non-UTF8 bytes), then boots an OPFS-backed VirtualFS and drives
 * the production `runLegacyMigrationFromVfs` end-to-end. Verifies
 * seven assertions: file-count parity, byte parity, symlink survival,
 * binary fidelity, sentinel-last ordering (including the forced
 * mismatch path), legacy IDB intact, and re-boot no-op.
 */
import FS from '@isomorphic-git/lightning-fs';
import { runLegacyMigrationCopy } from '../../src/fs/migration/migration-copy.js';
import { OPFS_MIGRATION_SENTINEL } from '../../src/fs/migration/migration-detect.js';
import { countOpfsFiles, runLegacyMigrationFromVfs } from '../../src/fs/migration/migration-run.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';

interface AssertResult {
  name: string;
  status: 'pass' | 'fail';
  detail?: string;
  observed?: unknown;
  expected?: unknown;
}

const results: AssertResult[] = [];
const root = document.getElementById('app')!;

function pass(name: string, detail?: string): void {
  results.push({ name, status: 'pass', detail });
}
function fail(name: string, observed: unknown, expected: unknown, detail?: string): void {
  results.push({ name, status: 'fail', observed, expected, detail });
}
function describeErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
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

// --- Fixture description ---------------------------------------------------
const BINARY_BYTES = new Uint8Array([0xff, 0x00, 0x80, 0x01, 0xfe, 0x7f, 0xc0, 0x80]);
const UTF8_TEXT = 'hello world\n';
const JSON_TEXT = '{"k":42}\n';
const FIXTURE = {
  fileCount: 3,
  // 12 + 9 + 8 = 29
  totalBytes: UTF8_TEXT.length + JSON_TEXT.length + BINARY_BYTES.length,
  symlinkTarget: '/seed-dir/nested/utf.txt',
  symlinkPath: '/link',
  binaryPath: '/binary.bin',
  utfPath: '/seed-dir/nested/utf.txt',
  jsonPath: '/seed-dir/nested/data.json',
};

async function deleteIdb(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
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

async function seedLegacyIdb(): Promise<void> {
  await deleteIdb('slicc-fs');
  const lfs = new FS('slicc-fs', { wipe: true }).promises;
  await lfs.mkdir('/seed-dir');
  await lfs.mkdir('/seed-dir/nested');
  await lfs.writeFile(FIXTURE.utfPath, UTF8_TEXT, 'utf8');
  await lfs.writeFile(FIXTURE.jsonPath, JSON_TEXT, 'utf8');
  await lfs.writeFile(FIXTURE.binaryPath, BINARY_BYTES);
  await lfs.symlink(FIXTURE.symlinkTarget, FIXTURE.symlinkPath);
}

interface IdbWalkResult {
  files: { path: string; bytes: Uint8Array }[];
  symlinks: { path: string; target: string }[];
  dirs: string[];
  fileCount: number;
  totalBytes: number;
}

async function walkLegacyIdb(): Promise<IdbWalkResult> {
  const lfs = new FS('slicc-fs').promises;
  const out: IdbWalkResult = {
    files: [],
    symlinks: [],
    dirs: [],
    fileCount: 0,
    totalBytes: 0,
  };
  const queue: string[] = ['/'];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    out.dirs.push(dir);
    const names = await lfs.readdir(dir);
    for (const name of names) {
      const p = dir === '/' ? `/${name}` : `${dir}/${name}`;
      const st = await lfs.lstat(p);
      if (st.isSymbolicLink()) {
        const target = await lfs.readlink(p);
        out.symlinks.push({ path: p, target });
      } else if (st.isDirectory()) {
        queue.push(p);
      } else if (st.isFile()) {
        const bytes = (await lfs.readFile(p)) as Uint8Array;
        out.files.push({ path: p, bytes });
        out.fileCount++;
        out.totalBytes += bytes.length;
      }
    }
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main(): Promise<void> {
  // 1) Clean slate
  await wipeOpfsSubdir('wave-c6-target');
  await wipeOpfsSubdir('wave-c6-target-mismatch');
  await seedLegacyIdb();

  // 2) Verify the seed matches the recorded fixture
  const seedSnapshot = await walkLegacyIdb();
  if (
    seedSnapshot.fileCount !== FIXTURE.fileCount ||
    seedSnapshot.totalBytes !== FIXTURE.totalBytes
  ) {
    fail(
      'C6.0 seed sanity (legacy IDB matches declared fixture)',
      { fileCount: seedSnapshot.fileCount, totalBytes: seedSnapshot.totalBytes },
      { fileCount: FIXTURE.fileCount, totalBytes: FIXTURE.totalBytes },
      'seed walk did not match declared fixture'
    );
    publishAndFinish();
    return;
  }
  pass(
    'C6.0 seed sanity (legacy IDB matches declared fixture)',
    `files=${seedSnapshot.fileCount}, bytes=${seedSnapshot.totalBytes}`
  );
  render();

  // 3) Boot OPFS-backed target VFS; instrument writeFile/symlink to capture
  // sentinel-presence at the moment of every write call.
  const vfs = await VirtualFS.create({
    dbName: 'wave-c6-target',
    backend: 'opfs',
    wipe: true,
  });
  const writeLog: { path: string; sentinelPresent: boolean }[] = [];
  const symlinkLog: { path: string; sentinelPresent: boolean }[] = [];
  const origWriteFile = vfs.writeFile.bind(vfs);
  const origSymlink = vfs.symlink.bind(vfs);
  async function isSentinelPresent(): Promise<boolean> {
    try {
      await vfs.stat(OPFS_MIGRATION_SENTINEL);
      return true;
    } catch {
      return false;
    }
  }
  vfs.writeFile = (async (path: string, content: unknown) => {
    const present = await isSentinelPresent();
    writeLog.push({ path, sentinelPresent: present });
    return origWriteFile(path, content as Parameters<typeof origWriteFile>[1]);
  }) as typeof vfs.writeFile;
  vfs.symlink = (async (target: string, linkPath: string) => {
    const present = await isSentinelPresent();
    symlinkLog.push({ path: linkPath, sentinelPresent: present });
    return origSymlink(target, linkPath);
  }) as typeof vfs.symlink;

  // 4) Run the production migration end-to-end against the real legacy IDB
  try {
    const result = await runLegacyMigrationFromVfs(vfs);
    if (
      result.kind !== 'copied' ||
      (result as { result?: { kind?: string } }).result?.kind !== 'success'
    ) {
      fail(
        'C6.bootstrap migration runLegacyMigrationFromVfs success',
        result,
        { kind: 'copied', result: { kind: 'success' } },
        'migration did not succeed'
      );
      publishAndFinish();
      return;
    }
  } catch (err) {
    fail('C6.bootstrap migration threw', describeErr(err), 'no throw');
    publishAndFinish();
    return;
  }

  // 5) Assertion 1: FILE-COUNT PARITY
  const opfsCount = await countOpfsFiles(vfs);
  if (opfsCount.fileCount === FIXTURE.fileCount) {
    pass(
      'C6.1 FILE-COUNT PARITY (OPFS files == seeded fixture)',
      `observed=${opfsCount.fileCount}, expected=${FIXTURE.fileCount}`
    );
  } else {
    fail('C6.1 FILE-COUNT PARITY', opfsCount.fileCount, FIXTURE.fileCount);
  }
  render();

  // 6) Assertion 2: BYTE PARITY
  if (opfsCount.totalBytes === FIXTURE.totalBytes) {
    pass(
      'C6.2 BYTE PARITY (OPFS total bytes == seeded fixture)',
      `observed=${opfsCount.totalBytes}, expected=${FIXTURE.totalBytes}`
    );
  } else {
    fail('C6.2 BYTE PARITY', opfsCount.totalBytes, FIXTURE.totalBytes);
  }
  render();

  // 7) Assertion 3: SYMLINK SURVIVAL (covers the deferred C2 follow-up)
  try {
    const target = await vfs.readlink(FIXTURE.symlinkPath);
    if (target === FIXTURE.symlinkTarget) {
      pass(
        'C6.3 SYMLINK SURVIVAL (vfs.readlink target matches seeded fixture)',
        `readlink(${FIXTURE.symlinkPath})="${target}"`
      );
    } else {
      fail('C6.3 SYMLINK SURVIVAL', { target }, { target: FIXTURE.symlinkTarget });
    }
  } catch (err) {
    fail('C6.3 SYMLINK SURVIVAL threw', describeErr(err), 'no throw');
  }
  render();

  // 8) Assertion 4: BINARY FIDELITY
  try {
    const bin = (await vfs.readFile(FIXTURE.binaryPath, { encoding: 'binary' })) as Uint8Array;
    if (bytesEqual(bin, BINARY_BYTES)) {
      pass(
        'C6.4 BINARY FIDELITY (read-back bytes byte-identical to fixture)',
        `length=${bin.length}, first=0x${bin[0].toString(16)}, last=0x${bin[bin.length - 1].toString(16)}`
      );
    } else {
      fail(
        'C6.4 BINARY FIDELITY',
        { length: bin.length, sample: Array.from(bin) },
        { length: BINARY_BYTES.length, sample: Array.from(BINARY_BYTES) }
      );
    }
  } catch (err) {
    fail('C6.4 BINARY FIDELITY threw', describeErr(err), 'no throw');
  }
  render();

  // 9) Assertion 5: SENTINEL-LAST. Two halves —
  //   (a) sentinel exists AFTER migration succeeds, AND
  //   (b) at every non-sentinel write/symlink during the copy the
  //       sentinel was absent (ordering proven via the per-call snapshot),
  //   (c) on a forced parity-mismatch the sentinel is NOT written.
  const sentinelExistsNow = await isSentinelPresent();
  const nonSentinelWrites = writeLog.filter((w) => w.path !== OPFS_MIGRATION_SENTINEL);
  const sentinelWrites = writeLog.filter((w) => w.path === OPFS_MIGRATION_SENTINEL);
  const allPriorWritesAbsent = nonSentinelWrites.every((w) => !w.sentinelPresent);
  const allSymlinksAbsent = symlinkLog.every((s) => !s.sentinelPresent);
  const sentinelWriteSawAbsent = sentinelWrites.every((w) => !w.sentinelPresent);

  // (c) Forced mismatch: build a fake oversized manifest against a fresh
  // OPFS subdir; assert the copy bails with parity-mismatch and the
  // sentinel is never written.
  const mismatchVfs = await VirtualFS.create({
    dbName: 'wave-c6-target-mismatch',
    backend: 'opfs',
    wipe: true,
  });
  let mismatchSentinelWritten = false;
  const mismatchResult = await runLegacyMigrationCopy({
    manifest: {
      entries: [{ type: 'file', path: '/ghost.txt', size: 999 }],
      fileCount: 1,
      dirCount: 0,
      symlinkCount: 0,
      totalBytes: 999,
    },
    source: { readFile: async () => new Uint8Array([1]) },
    target: {
      mkdir: async (p) => {
        await mismatchVfs.mkdir(p, { recursive: true });
      },
      writeFile: async (p, c) => {
        await mismatchVfs.writeFile(p, c);
      },
      symlink: async (t, l) => {
        await mismatchVfs.symlink(t, l);
      },
    },
    countOpfsFiles: () => countOpfsFiles(mismatchVfs),
    flushBeforeSentinel: () => mismatchVfs.flush().catch(() => {}),
    writeSentinel: async () => {
      mismatchSentinelWritten = true;
      await mismatchVfs.writeFile(OPFS_MIGRATION_SENTINEL, '');
    },
  });
  let mismatchSentinelExists = false;
  try {
    await mismatchVfs.stat(OPFS_MIGRATION_SENTINEL);
    mismatchSentinelExists = true;
  } catch {}
  await mismatchVfs.dispose();

  const orderingOk =
    sentinelExistsNow &&
    sentinelWrites.length >= 1 &&
    allPriorWritesAbsent &&
    allSymlinksAbsent &&
    sentinelWriteSawAbsent;
  const mismatchOk =
    mismatchResult.kind === 'parity-mismatch' &&
    !mismatchSentinelWritten &&
    !mismatchSentinelExists;

  if (orderingOk && mismatchOk) {
    pass(
      'C6.5 SENTINEL-LAST (present after success; absent mid-copy; never written on parity-mismatch)',
      `writes=${writeLog.length} (sentinel=${sentinelWrites.length}); symlinks=${symlinkLog.length}; mismatch.kind=${mismatchResult.kind}, mismatch.sentinelWritten=${mismatchSentinelWritten}`
    );
  } else {
    fail(
      'C6.5 SENTINEL-LAST',
      {
        sentinelExistsNow,
        sentinelWrites: sentinelWrites.length,
        nonSentinelWritesSeenSentinel: nonSentinelWrites.filter((w) => w.sentinelPresent).length,
        symlinksSeenSentinel: symlinkLog.filter((s) => s.sentinelPresent).length,
        mismatchKind: mismatchResult.kind,
        mismatchSentinelWritten,
        mismatchSentinelExists,
      },
      {
        sentinelExistsNow: true,
        sentinelWrites: '>=1',
        nonSentinelWritesSeenSentinel: 0,
        symlinksSeenSentinel: 0,
        mismatchKind: 'parity-mismatch',
        mismatchSentinelWritten: false,
        mismatchSentinelExists: false,
      },
      'sentinel ordering or forced-mismatch invariant violated'
    );
  }
  render();

  // 10) Assertion 6: LEGACY IDB INTACT — re-walk slicc-fs and confirm
  // every file/symlink is still present byte-identical to the seed.
  const postWalk = await walkLegacyIdb();
  const filesIntact =
    postWalk.fileCount === seedSnapshot.fileCount &&
    postWalk.totalBytes === seedSnapshot.totalBytes &&
    postWalk.symlinks.length === seedSnapshot.symlinks.length;
  let bytesIntact = true;
  for (const f of postWalk.files) {
    const seedFile = seedSnapshot.files.find((s) => s.path === f.path);
    if (!seedFile || !bytesEqual(seedFile.bytes, f.bytes)) {
      bytesIntact = false;
      break;
    }
  }
  const symlinkIntact =
    postWalk.symlinks.length === 1 &&
    postWalk.symlinks[0].path === FIXTURE.symlinkPath &&
    postWalk.symlinks[0].target === FIXTURE.symlinkTarget;
  if (filesIntact && bytesIntact && symlinkIntact) {
    pass(
      'C6.6 LEGACY IDB INTACT (slicc-fs unchanged after migration; escape hatch preserved)',
      `files=${postWalk.fileCount}, bytes=${postWalk.totalBytes}, symlinks=${postWalk.symlinks.length}`
    );
  } else {
    fail(
      'C6.6 LEGACY IDB INTACT',
      {
        files: postWalk.fileCount,
        bytes: postWalk.totalBytes,
        symlinks: postWalk.symlinks.length,
        bytesIntact,
        symlinkIntact,
      },
      {
        files: seedSnapshot.fileCount,
        bytes: seedSnapshot.totalBytes,
        symlinks: 1,
        bytesIntact: true,
        symlinkIntact: true,
      }
    );
  }
  render();

  // 11) Assertion 7: RE-BOOT NO-OP. Dispose and re-create the OPFS VFS
  // against the same subdir; the sentinel must survive, the migration
  // must return sentinel-present, and the spy factories (which would
  // build legacy readers) must NEVER be invoked.
  await vfs.dispose();
  const vfs2 = await VirtualFS.create({ dbName: 'wave-c6-target', backend: 'opfs' });
  let legacyReaderCalls = 0;
  let legacyLfsCalls = 0;
  let probeCalls = 0;
  const result2 = await runLegacyMigrationFromVfs(vfs2, {
    legacyReaderFactory: async () => {
      legacyReaderCalls++;
      return { readFile: async () => new Uint8Array() };
    },
    legacyLfsFactory: async () => {
      legacyLfsCalls++;
      return {
        readdir: async () => [],
        lstat: async () => ({}) as never,
        readlink: async () => '',
      };
    },
    probeLegacyDbExists: async () => {
      probeCalls++;
      return true;
    },
  });
  const sentinelAfterReboot = await (async () => {
    try {
      await vfs2.stat(OPFS_MIGRATION_SENTINEL);
      return true;
    } catch {
      return false;
    }
  })();
  await vfs2.dispose();
  if (
    result2.kind === 'sentinel-present' &&
    legacyReaderCalls === 0 &&
    legacyLfsCalls === 0 &&
    probeCalls === 0 &&
    sentinelAfterReboot
  ) {
    pass(
      'C6.7 RE-BOOT NO-OP (sentinel-present fast path; legacy reader not constructed)',
      `result.kind=${result2.kind}, legacyReader=${legacyReaderCalls}, legacyLfs=${legacyLfsCalls}, probe=${probeCalls}, sentinel=${sentinelAfterReboot}`
    );
  } else {
    fail(
      'C6.7 RE-BOOT NO-OP',
      {
        kind: result2.kind,
        legacyReaderCalls,
        legacyLfsCalls,
        probeCalls,
        sentinelAfterReboot,
      },
      {
        kind: 'sentinel-present',
        legacyReaderCalls: 0,
        legacyLfsCalls: 0,
        probeCalls: 0,
        sentinelAfterReboot: true,
      }
    );
  }
  render();
  publishAndFinish();
}

function publishAndFinish(): void {
  const allPassed = results.length > 0 && results.every((r) => r.status === 'pass');
  (globalThis as Record<string, unknown>).__waveC6Result = {
    ts: new Date().toISOString(),
    allPassed,
    results,
  };
  document.title = allPassed ? 'Wave C6 — PASS' : 'Wave C6 — FAIL';
  render();
}

main().catch((err) => {
  fail('C6 FATAL', describeErr(err), 'no throw', 'main() threw');
  (globalThis as Record<string, unknown>).__waveC6Result = {
    ts: new Date().toISOString(),
    allPassed: false,
    fatal: err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err),
    results,
  };
  document.title = 'Wave C6 — FATAL';
  root.innerHTML = `<pre style="color:#c00">FATAL: ${err instanceof Error ? err.stack : String(err)}</pre>`;
});
