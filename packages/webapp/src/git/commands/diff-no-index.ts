/**
 * `git diff --no-index` — diff two arbitrary paths with no repository involved.
 *
 * This is the one `git diff` mode that has to work from a cwd that is not
 * inside a repo at all (it is the standard way to get a unified diff of two
 * loose files), so it never calls isomorphic-git: both operands are read
 * straight off the VFS and rendered by the same `unifiedDiff` / stat formatter
 * every other diff mode uses. Real git treats `--no-index` as implying
 * `--exit-code`, so a difference exits 1 and an identical pair exits 0.
 *
 * Deliberate deviations from canonical git, mirrored in
 * `docs/shell-reference.md`: no `index` / `new file mode` / `deleted file mode`
 * header lines (SLICC's diff output carries no object IDs or modes anywhere)
 * and no rename or copy detection. Implicit `--no-index` — two paths handed to
 * a plain `git diff` run outside a repository — is not inferred; pass the flag.
 */

import { normalizePath } from '../../fs/path-utils.js';
import type { DiffStatEntry } from '../diff.js';
import { formatDiffStatText, unifiedDiff } from '../diff.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

const USAGE = 'usage: git diff --no-index [<options>] <path> <path>\n';

/** git's `/dev/null` operand: an empty file whether or not the path exists. */
const DEV_NULL = '/dev/null';

/** Leading bytes sniffed for a NUL before a pair is declared binary. */
const BINARY_SNIFF_BYTES = 8000;

/** Output-shaping flags `--no-index` honors. */
export interface NoIndexOptions {
  nameOnly: boolean;
  stat: boolean;
  /** Context lines around each hunk (`-U<n>`); `unifiedDiff` defaults to 3. */
  context?: number;
}

/** What a command-line operand turned out to be on disk. */
type Operand =
  | { kind: 'file'; abs: string; given: string }
  | { kind: 'dir'; abs: string; given: string }
  | { kind: 'null'; given: string }
  | { kind: 'missing'; given: string };

/** An operand already narrowed to a directory. */
type DirOperand = Extract<Operand, { kind: 'dir' }>;

/** A file's bytes plus its decoded text (empty when the bytes are binary). */
interface Blob {
  bytes: Uint8Array;
  /** Decoded content; always empty for a binary blob, which is never line-diffed. */
  text: string;
  binary: boolean;
}

/** The absent side of an addition or a deletion. */
const EMPTY_BLOB: Blob = { bytes: new Uint8Array(0), text: '', binary: false };

/**
 * One file pair to render. `absent` marks the side git heads with `/dev/null`;
 * for those pairs `oldName` and `newName` are both the PRESENT path, which is
 * what git puts on the `diff --git` line of an add or a delete.
 */
interface Pair {
  oldName: string;
  newName: string;
  absent?: 'old' | 'new';
  oldBlob: Blob;
  newBlob: Blob;
}

export async function diffNoIndex(
  ctx: GitCommandContext,
  cwd: string,
  paths: readonly string[],
  opts: NoIndexOptions
): Promise<GitCommandResult> {
  if (paths.length !== 2) return { stdout: '', stderr: USAGE, exitCode: 129 };

  let [left, right] = await Promise.all([
    classify(ctx, cwd, paths[0]),
    classify(ctx, cwd, paths[1]),
  ]);
  // `git diff --no-index <dir> <file>` diffs `<dir>/<basename of file>`.
  [left, right] = await joinDirOperand(ctx, cwd, left, right);

  const missing = left.kind === 'missing' ? left : right.kind === 'missing' ? right : undefined;
  if (missing) {
    return { stdout: '', stderr: `error: Could not access '${missing.given}'\n`, exitCode: 1 };
  }

  const pairs =
    left.kind === 'dir' && right.kind === 'dir'
      ? await collectDirPairs(ctx, left, right)
      : [await readPair(ctx, left, right)];

  const changed = pairs.filter((pair) => !bytesEqual(pair.oldBlob.bytes, pair.newBlob.bytes));
  if (changed.length === 0) return { stdout: '', stderr: '', exitCode: 0 };

  return { stdout: render(changed, opts), stderr: '', exitCode: 1 };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function render(pairs: readonly Pair[], opts: NoIndexOptions): string {
  if (opts.nameOnly) {
    return `${pairs.map((pair) => (pair.absent === 'new' ? DEV_NULL : pair.newName)).join('\n')}\n`;
  }
  if (opts.stat) return formatDiffStatText(pairs.map(statEntry));

  let output = '';
  for (const pair of pairs) {
    if (pair.oldBlob.binary || pair.newBlob.binary) {
      output += `diff --git a/${pair.oldName} b/${pair.newName}\n`;
      output += `Binary files ${sideLabel(pair, 'old')} and ${sideLabel(pair, 'new')} differ\n`;
      continue;
    }
    output += unifiedDiff({
      oldContent: pair.oldBlob.text,
      newContent: pair.newBlob.text,
      oldName: pair.oldName,
      newName: pair.newName,
      absent: pair.absent,
      context: opts.context,
    });
  }
  return output;
}

/** `a/<name>`, `b/<name>`, or `/dev/null` for the absent side of a pair. */
function sideLabel(pair: Pair, side: 'old' | 'new'): string {
  if (pair.absent === side) return DEV_NULL;
  return side === 'old' ? `a/${pair.oldName}` : `b/${pair.newName}`;
}

/** A `--stat` row: git labels it with the rename-compressed `old => new` form. */
function statEntry(pair: Pair): DiffStatEntry {
  const oldLabel = pair.absent === 'old' ? DEV_NULL : pair.oldName;
  const newLabel = pair.absent === 'new' ? DEV_NULL : pair.newName;
  return {
    name: pprintRename(oldLabel, newLabel),
    oldContent: pair.oldBlob.text,
    newContent: pair.newBlob.text,
    binary:
      pair.oldBlob.binary || pair.newBlob.binary
        ? { oldSize: pair.oldBlob.bytes.byteLength, newSize: pair.newBlob.bytes.byteLength }
        : undefined,
  };
}

/**
 * git's `pprint_rename`: collapse two paths into one stat row by bracketing
 * only the part that changed — `{A => B}/f.txt` — falling back to
 * `old => new` when the two share no whole path component.
 */
export function pprintRename(a: string, b: string): string {
  if (a === b) return a;

  let prefix = 0;
  const shortest = Math.min(a.length, b.length);
  for (let i = 0; i < shortest && a[i] === b[i]; i++) {
    if (a[i] === '/') prefix = i + 1;
  }

  // A common prefix always ends in a slash, so the suffix scan may run one
  // character back into it to see that same slash; without one it must not run
  // past the start of either string.
  const floor = prefix > 0 ? prefix - 1 : 0;
  let suffix = 0;
  for (let ai = a.length - 1, bi = b.length - 1; ai >= floor && bi >= floor; ai--, bi--) {
    if (a[ai] !== b[bi]) break;
    if (a[ai] === '/') suffix = a.length - ai;
  }

  if (prefix + suffix === 0) return `${a} => ${b}`;
  const aMid = a.slice(prefix, Math.max(prefix, a.length - suffix));
  const bMid = b.slice(prefix, Math.max(prefix, b.length - suffix));
  return `${a.slice(0, prefix)}{${aMid} => ${bMid}}${a.slice(a.length - suffix)}`;
}

async function classify(ctx: GitCommandContext, cwd: string, given: string): Promise<Operand> {
  if (given === DEV_NULL) return { kind: 'null', given };
  const abs = normalizePath(given.startsWith('/') ? given : `${cwd}/${given}`);
  try {
    const stats = await ctx.fs.stat(abs);
    return stats.type === 'directory' ? { kind: 'dir', abs, given } : { kind: 'file', abs, given };
  } catch {
    return { kind: 'missing', given };
  }
}

/**
 * git resolves `<dir> <file>` (either order) to `<dir>/<basename of file>`, so
 * `git diff --no-index A B/f.txt` compares `A/f.txt` with `B/f.txt`. The joined
 * path is re-classified, which is how a mismatch surfaces as
 * `Could not access 'A/f.txt'` rather than as a directory-vs-file error.
 */
async function joinDirOperand(
  ctx: GitCommandContext,
  cwd: string,
  left: Operand,
  right: Operand
): Promise<[Operand, Operand]> {
  if (left.kind === 'dir' && (right.kind === 'file' || right.kind === 'null')) {
    return [await classify(ctx, cwd, `${left.given}/${basename(right.given)}`), right];
  }
  if (right.kind === 'dir' && (left.kind === 'file' || left.kind === 'null')) {
    return [left, await classify(ctx, cwd, `${right.given}/${basename(left.given)}`)];
  }
  return [left, right];
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** The single pair for a file-vs-file (or `/dev/null`-vs-file) invocation. */
async function readPair(ctx: GitCommandContext, left: Operand, right: Operand): Promise<Pair> {
  const [oldBlob, newBlob] = await Promise.all([readSide(ctx, left), readSide(ctx, right)]);
  // `/dev/null` on one side is git's spelling of "this file does not exist",
  // which heads the patch as an addition or a deletion of the other side.
  const absent = left.kind === 'null' ? 'old' : right.kind === 'null' ? 'new' : undefined;
  const present = label(left.kind === 'null' ? right.given : left.given);
  return {
    oldName: absent ? present : label(left.given),
    newName: absent ? present : label(right.given),
    absent,
    oldBlob,
    newBlob,
  };
}

function readSide(ctx: GitCommandContext, operand: Operand): Promise<Blob> {
  return operand.kind === 'file' ? readBlob(ctx, operand.abs) : Promise.resolve(EMPTY_BLOB);
}

/**
 * The union of both trees, one pair per relative path, sorted so the output is
 * stable. A path present on only one side becomes an addition or a deletion,
 * which git names after the side that HAS it.
 */
async function collectDirPairs(
  ctx: GitCommandContext,
  left: DirOperand,
  right: DirOperand
): Promise<Pair[]> {
  const [leftFiles, rightFiles] = await Promise.all([
    listFiles(ctx, left.abs),
    listFiles(ctx, right.abs),
  ]);
  const union = [...new Set([...leftFiles, ...rightFiles])].sort();

  const pairs: Pair[] = [];
  for (const rel of union) {
    const oldName = label(`${left.given}/${rel}`);
    const newName = label(`${right.given}/${rel}`);
    if (!rightFiles.has(rel)) {
      pairs.push({
        oldName,
        newName: oldName,
        absent: 'new',
        oldBlob: await readBlob(ctx, `${left.abs}/${rel}`),
        newBlob: EMPTY_BLOB,
      });
    } else if (!leftFiles.has(rel)) {
      pairs.push({
        oldName: newName,
        newName,
        absent: 'old',
        oldBlob: EMPTY_BLOB,
        newBlob: await readBlob(ctx, `${right.abs}/${rel}`),
      });
    } else {
      pairs.push({
        oldName,
        newName,
        oldBlob: await readBlob(ctx, `${left.abs}/${rel}`),
        newBlob: await readBlob(ctx, `${right.abs}/${rel}`),
      });
    }
  }
  return pairs;
}

/** Every file below `root`, as paths relative to it. */
async function listFiles(ctx: GitCommandContext, root: string): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (rel: string): Promise<void> => {
    const entries = await ctx.fs.readDir(rel ? `${root}/${rel}` : root);
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.type === 'directory') await walk(child);
      else found.add(child);
    }
  };
  await walk('');
  return found;
}

async function readBlob(ctx: GitCommandContext, abs: string): Promise<Blob> {
  const content = await ctx.fs.readFile(abs, { encoding: 'binary' });
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const binary = bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  return { bytes, text: binary ? '' : new TextDecoder().decode(bytes), binary };
}

/**
 * The `a/` / `b/`-prefixed header name for a path. git strips the leading
 * slash of an absolute operand, so `/tmp/f` renders as `a/tmp/f`.
 */
function label(given: string): string {
  return given.replace(/^\/+/, '');
}
