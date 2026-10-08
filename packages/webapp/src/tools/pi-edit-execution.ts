import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
} from '@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js';
import { splitBom } from '@earendil-works/pi-coding-agent/dist/utils/text.js';
import { FsError, joinPath, normalizePath, type VirtualFS } from '../fs/index.js';
import type { EditArguments } from './edit-tool.js';
import type { ToolResult } from './types.js';
import { verifyWriteLanded } from './write-verification.js';

interface EditInput {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

function fileErrorCode(error: unknown): string {
  if (!(error instanceof FsError)) return 'unknown';
  switch (error.code) {
    case 'ENOENT':
      return 'not_found';
    case 'EACCES':
      return 'permission_denied';
    case 'ENOTDIR':
      return 'not_directory';
    case 'EISDIR':
      return 'is_directory';
    case 'EINVAL':
    case 'ELOOP':
      return 'invalid';
    default:
      return 'unknown';
  }
}

function validateEditInput(input: EditArguments): EditInput {
  if (typeof input.path !== 'string' || input.path.length === 0) {
    throw new Error('Edit tool input is invalid. path must be a non-empty string.');
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
  }
  for (const edit of input.edits) {
    const e = edit as { oldText?: unknown; newText?: unknown } | null;
    if (!e || typeof e.oldText !== 'string' || typeof e.newText !== 'string') {
      throw new Error('Edit tool input is invalid. Each edit needs string oldText and newText.');
    }
  }
  return { path: input.path, edits: input.edits as EditInput['edits'] };
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeToolPath(path: string): string {
  const normalized = path.replace(UNICODE_SPACES, ' ');
  return normalized.startsWith('@') ? normalized.slice(1) : normalized;
}

async function mutationQueueKey(
  fs: VirtualFS,
  path: string,
  absolutePath: string
): Promise<string> {
  try {
    return await fs.realpath(absolutePath);
  } catch (error) {
    if (error instanceof FsError && error.code === 'ENOENT') return absolutePath;
    throw new Error(`Could not edit file: ${path}. Error code: ${fileErrorCode(error)}.`);
  }
}

const fileQueues = new WeakMap<VirtualFS, Map<string, Promise<unknown>>>();

function withFileMutationQueue<T>(fs: VirtualFS, path: string, run: () => Promise<T>): Promise<T> {
  let byPath = fileQueues.get(fs);
  if (!byPath) fileQueues.set(fs, (byPath = new Map()));
  const previous = byPath.get(path) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.catch(() => undefined);
  byPath.set(path, settled);
  void settled.then(() => {
    if (byPath.get(path) === settled) byPath.delete(path);
  });
  return next;
}

export async function executePiEdit(
  fs: VirtualFS,
  cwd: string,
  input: EditArguments,
  signal?: AbortSignal
): Promise<ToolResult> {
  const { path, edits } = validateEditInput(input);
  const toolPath = normalizeToolPath(path);
  const absolutePath = normalizePath(toolPath.startsWith('/') ? toolPath : joinPath(cwd, toolPath));
  const queueKey = await mutationQueueKey(fs, path, absolutePath);
  return withFileMutationQueue(fs, queueKey, async () => {
    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error('Operation aborted');
    };
    throwIfAborted();
    let kind: string;
    try {
      kind = (await fs.lstat(absolutePath)).type;
    } catch (error) {
      throwIfAborted();
      throw new Error(`Could not edit file: ${path}. Error code: ${fileErrorCode(error)}.`);
    }
    if (kind !== 'file' && kind !== 'symlink') {
      throw new Error(`Could not edit file: ${path}. Path is not a file.`);
    }
    let rawContent: string;
    try {
      rawContent = await fs.readTextFile(absolutePath);
    } catch (error) {
      throwIfAborted();
      throw new Error(`Could not edit file: ${path}. Error code: ${fileErrorCode(error)}.`);
    }
    throwIfAborted();

    const { bom, text: content } = splitBom(rawContent);
    const originalEnding = detectLineEnding(content);
    const { newContent } = applyEditsToNormalizedContent(normalizeToLF(content), edits, path);
    throwIfAborted();
    const finalContent = bom + restoreLineEndings(newContent, originalEnding);
    try {
      await fs.writeFile(absolutePath, finalContent);
    } catch (error) {
      throw new Error(`Could not edit file: ${path}. Error code: ${fileErrorCode(error)}.`);
    }
    if (await verifyWriteLanded(fs, absolutePath, finalContent)) {
      throw new Error(`Could not edit file: ${path}. Error code: unknown.`);
    }
    throwIfAborted();
    return { content: `Successfully replaced ${edits.length} block(s) in ${path}.` };
  });
}
