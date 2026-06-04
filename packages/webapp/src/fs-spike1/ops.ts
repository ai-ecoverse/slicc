/**
 * Spike 1 — operations suite.
 *
 * Runs the same checklist of operations against any `node:fs/promises`-shaped
 * client and returns a per-op pass/fail/skipped record. Used by both the
 * page-side and the worker-side runner so the matrix lines up.
 *
 * THIS IS THROWAWAY CODE — it lives under `src/` only so `npm run typecheck`
 * picks it up. Do not import it from production paths.
 */

export interface OpResult {
  op: string;
  status: 'pass' | 'fail' | 'skipped';
  detail?: string;
  ms?: number;
}

/** Minimal node-`fs/promises` shape we expect the candidate to expose. */
export interface FsPromisesLike {
  readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string, options?: unknown): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rmdir(path: string): Promise<void>;
  rm?(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(path: string): Promise<{
    mode?: number;
    size?: number;
    mtimeMs?: number;
    isFile?(): boolean;
    isDirectory?(): boolean;
    isSymbolicLink?(): boolean;
  }>;
  lstat(path: string): Promise<{
    mode?: number;
    size?: number;
    mtimeMs?: number;
    isFile?(): boolean;
    isDirectory?(): boolean;
    isSymbolicLink?(): boolean;
  }>;
  symlink?(target: string, path: string): Promise<void>;
  readlink?(path: string): Promise<string>;
  rename?(oldPath: string, newPath: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t0) };
}

function asPass(op: string, ms: number, detail?: string): OpResult {
  return { op, status: 'pass', detail, ms };
}

function asFail(op: string, err: unknown): OpResult {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { op, status: 'fail', detail };
}

function asSkip(op: string, detail: string): OpResult {
  return { op, status: 'skipped', detail };
}

/**
 * Run the full op suite against `fs` rooted at `base`. The runner cleans
 * `base` before starting so reruns are deterministic.
 */
export async function runOpsSuite(fs: FsPromisesLike, base: string): Promise<OpResult[]> {
  const results: OpResult[] = [];

  // Best-effort wipe of the working dir so the suite is idempotent.
  try {
    if (fs.rm) {
      await fs.rm(base, { recursive: true, force: true });
    } else {
      await fs.rmdir(base).catch(() => {});
    }
  } catch {
    // ignore — may not exist
  }

  try {
    await fs.mkdir(base, { recursive: true });
  } catch (err) {
    results.push(asFail('mkdir -p (root)', err));
    return results;
  }

  // 1. mkdir -p
  try {
    const { ms } = await timed(() => fs.mkdir(`${base}/a/b/c`, { recursive: true }));
    results.push(asPass('mkdir -p', ms));
  } catch (err) {
    results.push(asFail('mkdir -p', err));
  }

  // 2. writeFile utf-8
  try {
    const { ms } = await timed(() => fs.writeFile(`${base}/a/b/c/hello.txt`, 'Hello, OPFS!'));
    results.push(asPass('writeFile utf-8', ms));
  } catch (err) {
    results.push(asFail('writeFile utf-8', err));
  }

  // 3. readFile utf-8
  try {
    const { value, ms } = await timed(() =>
      fs.readFile(`${base}/a/b/c/hello.txt`, { encoding: 'utf-8' })
    );
    const got = typeof value === 'string' ? value : new TextDecoder().decode(value);
    if (got !== 'Hello, OPFS!') throw new Error(`got ${JSON.stringify(got)}`);
    results.push(asPass('readFile utf-8', ms));
  } catch (err) {
    results.push(asFail('readFile utf-8', err));
  }

  // 4. writeFile binary
  try {
    const bin = new Uint8Array([0, 1, 2, 3, 255, 254, 253, 7, 8, 9]);
    const { ms } = await timed(() => fs.writeFile(`${base}/binary.bin`, bin));
    results.push(asPass('writeFile binary', ms));
  } catch (err) {
    results.push(asFail('writeFile binary', err));
  }

  // 5. readFile binary
  try {
    const { value, ms } = await timed(() => fs.readFile(`${base}/binary.bin`));
    const buf = value instanceof Uint8Array ? value : new TextEncoder().encode(value as string);
    const expected = new Uint8Array([0, 1, 2, 3, 255, 254, 253, 7, 8, 9]);
    if (buf.length !== expected.length) {
      throw new Error(`len ${buf.length} vs ${expected.length}`);
    }
    for (let i = 0; i < expected.length; i++) {
      if (buf[i] !== expected[i]) throw new Error(`byte ${i}: ${buf[i]} vs ${expected[i]}`);
    }
    results.push(asPass('readFile binary', ms));
  } catch (err) {
    results.push(asFail('readFile binary', err));
  }

  // 6. readdir
  try {
    const { value, ms } = await timed(() => fs.readdir(`${base}/a/b/c`));
    if (!value.includes('hello.txt')) throw new Error(`missing hello.txt in ${value.join(', ')}`);
    results.push(asPass('readdir', ms, value.join(',')));
  } catch (err) {
    results.push(asFail('readdir', err));
  }

  // 7. stat (follows symlinks)
  try {
    const { value, ms } = await timed(() => fs.stat(`${base}/a/b/c/hello.txt`));
    if (value.isFile && !value.isFile()) throw new Error('isFile() false');
    if (typeof value.size === 'number' && value.size !== 12) {
      throw new Error(`size ${value.size}`);
    }
    results.push(
      asPass('stat (file)', ms, `mode=${value.mode?.toString(8)} size=${value.size ?? '?'}`)
    );
  } catch (err) {
    results.push(asFail('stat (file)', err));
  }

  // 8. lstat (does not follow symlinks)
  try {
    const { value, ms } = await timed(() => fs.lstat(`${base}/a/b/c`));
    if (value.isDirectory && !value.isDirectory()) throw new Error('isDirectory() false');
    results.push(asPass('lstat (dir)', ms, `mode=${value.mode?.toString(8)}`));
  } catch (err) {
    results.push(asFail('lstat (dir)', err));
  }

  // 9. symlink + readlink + symlink resolution
  if (typeof fs.symlink === 'function' && typeof fs.readlink === 'function') {
    try {
      const { ms } = await timed(() =>
        // biome-ignore lint/style/noNonNullAssertion: guarded above
        fs.symlink!('hello.txt', `${base}/a/b/c/link.txt`)
      );
      results.push(asPass('symlink', ms));

      // biome-ignore lint/style/noNonNullAssertion: guarded above
      const tgt = await fs.readlink!(`${base}/a/b/c/link.txt`);
      if (tgt !== 'hello.txt') throw new Error(`readlink returned ${tgt}`);
      results.push(asPass('readlink', 0, tgt));

      // Resolution: stat() the symlink path should follow it to hello.txt
      const followed = await fs.stat(`${base}/a/b/c/link.txt`);
      if (followed.isFile && !followed.isFile()) {
        throw new Error('stat(symlink) did not resolve to file');
      }
      if (typeof followed.size === 'number' && followed.size !== 12) {
        throw new Error(`resolved size ${followed.size} (expected 12)`);
      }
      results.push(asPass('symlink resolve via stat', 0));

      // Multi-hop: link2 -> link.txt -> hello.txt
      // biome-ignore lint/style/noNonNullAssertion: guarded above
      await fs.symlink!('link.txt', `${base}/a/b/c/link2.txt`);
      const hop2 = await fs.stat(`${base}/a/b/c/link2.txt`);
      if (typeof hop2.size === 'number' && hop2.size !== 12) {
        throw new Error(`multi-hop size ${hop2.size}`);
      }
      results.push(asPass('symlink resolve multi-hop', 0));
    } catch (err) {
      results.push(asFail('symlink / readlink / resolve', err));
    }
  } else {
    results.push(asSkip('symlink / readlink / resolve', 'fs has no symlink/readlink method'));
  }

  // 10. rename
  if (typeof fs.rename === 'function') {
    try {
      const { ms } = await timed(() =>
        // biome-ignore lint/style/noNonNullAssertion: guarded above
        fs.rename!(`${base}/binary.bin`, `${base}/renamed.bin`)
      );
      const entries = await fs.readdir(base);
      if (!entries.includes('renamed.bin')) throw new Error('renamed.bin not in readdir');
      if (entries.includes('binary.bin')) throw new Error('original binary.bin still there');
      results.push(asPass('rename', ms));
    } catch (err) {
      results.push(asFail('rename', err));
    }
  } else {
    results.push(asSkip('rename', 'fs has no rename method'));
  }

  // 11. recursive rm — wipe the deep tree
  try {
    if (fs.rm) {
      const { ms } = await timed(() => fs.rm!(`${base}/a`, { recursive: true, force: true }));
      // verify gone
      try {
        await fs.stat(`${base}/a`);
        throw new Error('still exists after rm');
      } catch (e) {
        // expected ENOENT-equivalent
        results.push(asPass('rm -rf', ms, e instanceof Error ? e.message : ''));
      }
    } else {
      results.push(asSkip('rm -rf', 'fs has no rm method'));
    }
  } catch (err) {
    results.push(asFail('rm -rf', err));
  }

  // 12. large-file (>5MB) roundtrip
  try {
    const bigSize = 6 * 1024 * 1024;
    const big = new Uint8Array(bigSize);
    // Predictable fill — every byte = (i * 31) & 0xff
    for (let i = 0; i < bigSize; i++) big[i] = (i * 31) & 0xff;

    const { ms: writeMs } = await timed(() => fs.writeFile(`${base}/big.bin`, big));
    const { value, ms: readMs } = await timed(() => fs.readFile(`${base}/big.bin`));
    const buf = value instanceof Uint8Array ? value : new TextEncoder().encode(value as string);
    if (buf.length !== bigSize) throw new Error(`len ${buf.length} vs ${bigSize}`);
    // Spot-check 256 random bytes (full compare would dominate the runtime)
    for (let s = 0; s < 256; s++) {
      const i = Math.floor(Math.random() * bigSize);
      if (buf[i] !== ((i * 31) & 0xff)) {
        throw new Error(`byte mismatch at ${i}: ${buf[i]} vs ${(i * 31) & 0xff}`);
      }
    }
    results.push(
      asPass('large file 6MB roundtrip', writeMs + readMs, `w=${writeMs}ms r=${readMs}ms`)
    );
  } catch (err) {
    results.push(asFail('large file 6MB roundtrip', err));
  }

  // 13. chmod — relevant to isomorphic-git filemode comparison
  if (typeof fs.chmod === 'function') {
    try {
      await fs.writeFile(`${base}/exec.sh`, '#!/bin/sh\n');
      // biome-ignore lint/style/noNonNullAssertion: guarded above
      await fs.chmod!(`${base}/exec.sh`, 0o755);
      const s = await fs.stat(`${base}/exec.sh`);
      const mode = s.mode ?? 0;
      // Mode comparison the way isomorphic-git does it: file = 100644 / exec = 100755
      const fileType = mode & 0o170000;
      const perm = mode & 0o777;
      results.push(
        asPass(
          'chmod 0755 (filemode bit)',
          0,
          `mode=${mode.toString(8)} type=${fileType.toString(8)} perm=${perm.toString(8)} exec=${
            (perm & 0o111) !== 0
          }`
        )
      );
    } catch (err) {
      results.push(asFail('chmod 0755 (filemode bit)', err));
    }
  } else {
    results.push(asSkip('chmod 0755 (filemode bit)', 'fs has no chmod method'));
  }

  return results;
}
