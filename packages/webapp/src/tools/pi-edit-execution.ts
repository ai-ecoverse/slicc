/** Pi's edit tool bound to SLICC's browser-backed virtual filesystem. */

import type {
  EditToolInput,
  ExecutionEnv,
  ExecutionError,
  FileError,
  FileErrorCode,
  FileInfo,
} from '@earendil-works/pi-agent-core';
import { FsError, joinPath, normalizePath, splitPath, type VirtualFS } from '../fs/index.js';
import type { EditArguments } from './edit-tool.js';
import type { ToolResult } from './types.js';
import { verifyWriteLanded } from './write-verification.js';

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
type PiCore = typeof import('@earendil-works/pi-agent-core/edit-tool');
type PiEditTool = ReturnType<PiCore['createEditTool']>;

let piEditToolPromise: Promise<PiEditTool> | undefined;

function loadPiEditTool(): Promise<PiEditTool> {
  piEditToolPromise ??= import('@earendil-works/pi-agent-core/edit-tool').then(
    ({ createEditTool }) => createEditTool()
  );
  return piEditToolPromise;
}

function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value };
}

function err<T = never, E = Error>(error: E): Result<T, E> {
  return { ok: false, error };
}

class VfsFileError extends Error implements FileError {
  constructor(
    readonly code: FileErrorCode,
    message: string,
    readonly path?: string,
    cause?: Error
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FileError';
  }
}

class VfsExecutionError extends Error implements ExecutionError {
  readonly code = 'shell_unavailable' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ExecutionError';
  }
}

function fileErrorCode(error: unknown): FileErrorCode {
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

function asFileError(error: unknown, path?: string): FileError {
  if (error instanceof VfsFileError) return error;
  const cause = error instanceof Error ? error : new Error(String(error));
  return new VfsFileError(fileErrorCode(error), cause.message, path, cause);
}

function aborted<T>(signal: AbortSignal | undefined, path?: string): Result<T, FileError> | null {
  return signal?.aborted ? err(new VfsFileError('aborted', 'aborted', path)) : null;
}

/**
 * Pi currently consumes only these five filesystem operations. The rest fail
 * explicitly so future Pi changes cannot escape the VFS or throw across its
 * Result-based environment boundary.
 */
class VfsEditExecutionEnv implements ExecutionEnv {
  constructor(
    private readonly fs: VirtualFS,
    readonly cwd: string
  ) {}

  async absolutePath(path: string, signal?: AbortSignal): Promise<Result<string, FileError>> {
    const stopped = aborted<string>(signal, path);
    if (stopped) return stopped;
    return ok(normalizePath(path.startsWith('/') ? path : joinPath(this.cwd, path)));
  }

  async canonicalPath(path: string, signal?: AbortSignal): Promise<Result<string, FileError>> {
    const absolute = await this.absolutePath(path, signal);
    if (!absolute.ok) return absolute;
    try {
      return ok(await this.fs.realpath(absolute.value));
    } catch (error) {
      return err(asFileError(error, absolute.value));
    }
  }

  async fileInfo(path: string, signal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    const absolute = await this.absolutePath(path, signal);
    if (!absolute.ok) return absolute;
    try {
      const stats = await this.fs.lstat(absolute.value);
      return ok({
        name: splitPath(absolute.value).base,
        path: absolute.value,
        kind: stats.type,
        size: stats.size,
        mtimeMs: stats.mtime,
      });
    } catch (error) {
      return err(asFileError(error, absolute.value));
    }
  }

  async readTextFile(path: string, signal?: AbortSignal): Promise<Result<string, FileError>> {
    const absolute = await this.absolutePath(path, signal);
    if (!absolute.ok) return absolute;
    try {
      const content = await this.fs.readTextFile(absolute.value);
      return aborted<string>(signal, absolute.value) ?? ok(content);
    } catch (error) {
      return err(asFileError(error, absolute.value));
    }
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    signal?: AbortSignal
  ): Promise<Result<void, FileError>> {
    const absolute = await this.absolutePath(path, signal);
    if (!absolute.ok) return absolute;
    try {
      await this.fs.writeFile(absolute.value, content);
      if (typeof content === 'string') {
        const durabilityError = await verifyWriteLanded(this.fs, absolute.value, content);
        if (durabilityError) {
          return err(new VfsFileError('unknown', durabilityError, absolute.value));
        }
      }
      return aborted<void>(signal, absolute.value) ?? ok(undefined);
    } catch (error) {
      return err(asFileError(error, absolute.value));
    }
  }

  private unsupported<T>(operation: string, path?: string): Result<T, FileError> {
    return err(
      new VfsFileError('not_supported', `${operation} is unavailable to the edit tool`, path)
    );
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(joinPath(...parts));
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal }
  ): Promise<Result<string[], FileError>> {
    const result = await this.readTextFile(path, options?.abortSignal);
    if (!result.ok) return result;
    const lines = result.value.split(/\r?\n/);
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
    return this.unsupported('readBinaryFile', path);
  }

  async appendFile(path: string): Promise<Result<void, FileError>> {
    return this.unsupported('appendFile', path);
  }

  async renameFile(sourcePath: string): Promise<Result<void, FileError>> {
    return this.unsupported('renameFile', sourcePath);
  }

  async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
    return this.unsupported('listDir', path);
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    return this.unsupported('exists', path);
  }

  async createDir(path: string): Promise<Result<void, FileError>> {
    return this.unsupported('createDir', path);
  }

  async remove(path: string): Promise<Result<void, FileError>> {
    return this.unsupported('remove', path);
  }

  async createTempDir(): Promise<Result<string, FileError>> {
    return this.unsupported('createTempDir');
  }

  async createTempFile(): Promise<Result<string, FileError>> {
    return this.unsupported('createTempFile');
  }

  async exec(): Promise<
    Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
  > {
    return err(new VfsExecutionError('Shell is unavailable to the edit tool'));
  }

  async cleanup(): Promise<void> {}
}

/** Execute an edit with Pi's public implementation against SLICC's VFS. */
export async function executePiEdit(
  fs: VirtualFS,
  cwd: string,
  input: EditArguments,
  signal?: AbortSignal
): Promise<ToolResult> {
  const piTool = await loadPiEditTool();
  const result = await piTool.execute('slicc-edit', input as EditToolInput, signal, undefined, {
    env: new VfsEditExecutionEnv(fs, cwd),
  });
  return {
    content: result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
  };
}
