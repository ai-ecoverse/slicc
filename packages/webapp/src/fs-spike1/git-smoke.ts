/**
 * Spike 1 — isomorphic-git smoke test.
 *
 * Runs init → add → commit → statusMatrix → (optional) clone against any
 * `node-fs`-shaped client. The filemode-comparison line in `statusMatrix`
 * is the bit the task explicitly calls out: it must still work for the
 * candidate fs, which means `stat().mode` must round-trip the executable
 * bit (`0o100755`) through writeFile → readFile.
 *
 * THIS IS THROWAWAY CODE.
 */

// Buffer polyfill MUST be loaded before isomorphic-git (mirrors the
// production `git/git-commands.ts` ordering).
import '../shims/buffer-polyfill.js';
import type { FsClient } from 'isomorphic-git';
import * as git from 'isomorphic-git';
// http client is loaded lazily inside the clone step so the page can run
// the offline portion of the suite without pulling the web-http module
// when vite's optimizeDeps hasn't pre-bundled the subpath.
import type { FsPromisesLike, OpResult } from './ops.js';

/** A `PromiseFsClient` shape — what isomorphic-git wants. */
export interface IsoFsClient {
  promises: FsPromisesLike & {
    readlink?(path: string): Promise<string>;
    symlink?(target: string, path: string): Promise<void>;
  };
}

/** Coerce our duck-typed candidate fs into isomorphic-git's FsClient. */
function asFsClient(fs: IsoFsClient): FsClient {
  return fs as unknown as FsClient;
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

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t0) };
}

export interface GitSmokeOptions {
  /** Repo dir inside `fs` (already cleaned by the caller). */
  dir: string;
  /** Optional repo + cors-proxy for the clone step; skipped if absent. */
  cloneUrl?: string;
  corsProxy?: string;
  /** Separate dir for the clone (clone dir must not exist). */
  cloneDir?: string;
  /** Default branch (defaults to `master` for older repos). */
  cloneRef?: string;
}

/**
 * Runs the git smoke suite. Returns a per-step `OpResult[]`.
 * The fs client is the candidate under test (ZenFS-WebAccess in Spike 1).
 */
export async function runGitSmoke(fs: IsoFsClient, opts: GitSmokeOptions): Promise<OpResult[]> {
  const results: OpResult[] = [];
  const { dir } = opts;

  // 1. git init
  try {
    const { ms } = await timed(() => git.init({ fs: asFsClient(fs), dir, defaultBranch: 'main' }));
    results.push(asPass('git init', ms));
  } catch (err) {
    results.push(asFail('git init', err));
    return results;
  }

  // 2. write two files (one plain, one with the exec bit) + git add
  try {
    await fs.promises.writeFile(`${dir}/readme.md`, '# Spike 1\n');
    await fs.promises.writeFile(`${dir}/run.sh`, '#!/bin/sh\necho hi\n');
    if (typeof fs.promises.chmod === 'function') {
      await fs.promises.chmod(`${dir}/run.sh`, 0o755);
    }
    const { ms } = await timed(async () => {
      await git.add({ fs: asFsClient(fs), dir, filepath: 'readme.md' });
      await git.add({ fs: asFsClient(fs), dir, filepath: 'run.sh' });
    });
    results.push(asPass('git add', ms));
  } catch (err) {
    results.push(asFail('git add', err));
  }

  // 3. git commit
  let commitSha = '';
  try {
    const { value, ms } = await timed(() =>
      git.commit({
        fs: asFsClient(fs),
        dir,
        message: 'spike1 initial',
        author: { name: 'Spike', email: 'spike@example.com' },
      })
    );
    commitSha = value;
    results.push(asPass('git commit', ms, value.slice(0, 8)));
  } catch (err) {
    results.push(asFail('git commit', err));
  }

  // 4. git statusMatrix — exercises filemode comparison
  try {
    const { value, ms } = await timed(() => git.statusMatrix({ fs: asFsClient(fs), dir }));
    // After commit + no edits, every entry should be [name, 1, 1, 1].
    const dirty = value.filter((row) => !(row[1] === 1 && row[2] === 1 && row[3] === 1));
    if (dirty.length > 0) {
      throw new Error(`statusMatrix has dirty rows after clean commit: ${JSON.stringify(dirty)}`);
    }
    results.push(asPass('git statusMatrix (clean)', ms, `${value.length} entries`));
  } catch (err) {
    results.push(asFail('git statusMatrix (clean)', err));
  }

  // 5. statusMatrix sees a new file
  try {
    await fs.promises.writeFile(`${dir}/new.txt`, 'new\n');
    const { value, ms } = await timed(() => git.statusMatrix({ fs: asFsClient(fs), dir }));
    const newRow = value.find((row) => row[0] === 'new.txt');
    if (!newRow) throw new Error('new.txt missing from statusMatrix');
    // untracked: head=0, workdir=2, stage=0
    if (newRow[1] !== 0 || newRow[2] !== 2 || newRow[3] !== 0) {
      throw new Error(`new.txt row = ${JSON.stringify(newRow)} (expected [name,0,2,0])`);
    }
    results.push(asPass('git statusMatrix (untracked)', ms, JSON.stringify(newRow)));
  } catch (err) {
    results.push(asFail('git statusMatrix (untracked)', err));
  }

  // 6. filemode bit round-trip — exec bit must survive stat() so isomorphic-git
  //    treats run.sh as 100755 rather than 100644
  if (commitSha) {
    try {
      const tree = await git.readTree({ fs: asFsClient(fs), dir, oid: commitSha });
      const run = tree.tree.find((e) => e.path === 'run.sh');
      if (!run) throw new Error('run.sh missing from tree');
      const mode = run.mode;
      // isomorphic-git canonical exec mode is "100755"
      if (mode !== '100755') {
        results.push(
          asFail(
            'filemode bit round-trip (exec → 100755 in tree)',
            new Error(`run.sh tree mode = ${mode} (expected 100755)`)
          )
        );
      } else {
        results.push(asPass('filemode bit round-trip (exec → 100755 in tree)', 0, mode));
      }
    } catch (err) {
      results.push(asFail('filemode bit round-trip (exec → 100755 in tree)', err));
    }
  }

  // 7. optional small clone
  if (opts.cloneUrl && opts.cloneDir) {
    try {
      // Vite's import-analysis pass can't resolve the
      // `isomorphic-git/http/web` exports subpath in dev (the static
      // top-level form failed at pre-transform), so reach for the
      // file directly. This is throwaway scratch code anyway.
      const httpMod = (await import(
        /* @vite-ignore */ '/node_modules/isomorphic-git/http/web/index.js'
      )) as { default: unknown };
      const http = httpMod.default;
      const { ms } = await timed(() =>
        git.clone({
          fs: asFsClient(fs),
          // biome-ignore lint/suspicious/noExplicitAny: dynamic-import type
          http: http as any,
          dir: opts.cloneDir!,
          url: opts.cloneUrl!,
          corsProxy: opts.corsProxy,
          // Explicit ref so older repos with `master` default still work.
          ref: opts.cloneRef ?? 'master',
          singleBranch: true,
          depth: 1,
        })
      );
      // Verify head + a readable file
      const head = await git.resolveRef({
        fs: asFsClient(fs),
        dir: opts.cloneDir!,
        ref: 'HEAD',
      });
      const entries = await fs.promises.readdir(opts.cloneDir!);
      results.push(
        asPass(
          'git clone (depth=1, single-branch)',
          ms,
          `HEAD=${head.slice(0, 8)} files=${entries.length}`
        )
      );
    } catch (err) {
      results.push(asFail('git clone (depth=1, single-branch)', err));
    }
  } else {
    results.push(asSkip('git clone (depth=1, single-branch)', 'no cloneUrl supplied'));
  }

  return results;
}
