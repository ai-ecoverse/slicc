import { normalizePath } from '../../fs/path-utils.js';
import type { DiffStatEntry } from '../diff.js';
import { formatDiffStatText, unifiedDiff } from '../diff.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

const USAGE = 'usage: git diff --no-index [<options>] <path> <path>\n';

const DEV_NULL = '/dev/null';

const BINARY_SNIFF_BYTES = 8000;

export interface NoIndexOptions {
  nameOnly: boolean;
  stat: boolean;

  context?: number;
}

type Operand =
  | { kind: 'file'; abs: string; given: string }
  | { kind: 'dir'; abs: string; given: string }
  | { kind: 'null'; given: string }
  | { kind: 'missing'; given: string };

type DirOperand = Extract<Operand, { kind: 'dir' }>;

interface Blob {
  bytes: Uint8Array;

  text: string;
  binary: boolean;
}

const EMPTY_BLOB: Blob = { bytes: new Uint8Array(0), text: '', binary: false };

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

function sideLabel(pair: Pair, side: 'old' | 'new'): string {
  if (pair.absent === side) return DEV_NULL;
  return side === 'old' ? `a/${pair.oldName}` : `b/${pair.newName}`;
}

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

export function pprintRename(a: string, b: string): string {
  if (a === b) return a;

  let prefix = 0;
  const shortest = Math.min(a.length, b.length);
  for (let i = 0; i < shortest && a[i] === b[i]; i++) {
    if (a[i] === '/') prefix = i + 1;
  }

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

async function readPair(ctx: GitCommandContext, left: Operand, right: Operand): Promise<Pair> {
  const [oldBlob, newBlob] = await Promise.all([readSide(ctx, left), readSide(ctx, right)]);

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

function label(given: string): string {
  return given.replace(/^\/+/, '');
}
