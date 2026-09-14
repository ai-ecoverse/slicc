import type { IFileSystem } from 'just-bash';

interface NativeFileFs {
  getNativeFile?(path: string): Promise<File | null>;
  readFileRange?(path: string, start: number, end: number): Promise<Uint8Array>;
}

const VERIFY_HEAD_BYTES = 64;

export async function readInputBlob(
  fs: IFileSystem,
  absPath: string,
  note?: (line: string) => void
): Promise<Blob> {
  const nativeFs = fs as IFileSystem & NativeFileFs;
  if (typeof nativeFs.getNativeFile === 'function') {
    try {
      const file = await nativeFs.getNativeFile(absPath);
      if (file) {
        const lazy = await cloneableBlob(file, absPath, note);
        if (await matchesVfs(nativeFs, absPath, lazy, note)) return lazy;
      }
    } catch {}
  }
  return bytesToBlob(await fs.readFileBuffer(absPath));
}

export async function matchesVfs(
  fs: IFileSystem & NativeFileFs,
  absPath: string,
  lazy: Blob,
  note?: (line: string) => void
): Promise<boolean> {
  if (typeof fs.readFileRange !== 'function') return true;
  let expected: Uint8Array;
  let size: number | undefined;
  try {
    expected = await fs.readFileRange(absPath, 0, VERIFY_HEAD_BYTES);
    size = (await fs.stat(absPath)).size;
  } catch {
    return true;
  }
  const actual = new Uint8Array(await lazy.slice(0, VERIFY_HEAD_BYTES).arrayBuffer());
  const same =
    (size === undefined || size === lazy.size) &&
    actual.byteLength === expected.byteLength &&
    actual.every((b, i) => b === expected[i]);
  if (!same) {
    note?.(
      `ffmpeg: ${absPath}: native File (${lazy.size} bytes) does not match the VFS (${size ?? '?'} bytes, head differs=${actual.byteLength !== expected.byteLength || actual.some((b, i) => b !== expected[i])}); reading it through the VFS instead`
    );
  }
  return same;
}

export type CloneProbe = (value: unknown) => void;

export async function cloneableBlob(
  file: Blob,
  label: string,
  note?: (line: string) => void,
  probe: CloneProbe = (v) => void structuredClone(v)
): Promise<Blob> {
  let failure = '';
  const clones = (value: Blob): boolean => {
    try {
      probe(value);
      return true;
    } catch (err) {
      failure = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return false;
    }
  };
  if (clones(file)) return file;
  const wrapped = new Blob([file], { type: file.type });
  if (clones(wrapped)) {
    note?.(
      `ffmpeg: ${label}: native File is not transferable to the worker (${describeBlob(file)}; ${failure}); wrapped it in a Blob`
    );
    return wrapped;
  }
  note?.(
    `ffmpeg: ${label}: native File is not transferable to the worker and neither is a Blob over it; read ${file.size} bytes into memory instead`
  );
  return new Blob([await file.arrayBuffer()], { type: file.type });
}

export function bytesToBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>]);
}

function describeBlob(value: Blob): string {
  const ctor = (value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
  const isFile = typeof File !== 'undefined' && value instanceof File;
  const isBlob = value instanceof Blob;
  return `${ctor}, instanceof File=${isFile}, instanceof Blob=${isBlob}, size=${value.size}, type=${JSON.stringify(value.type)}`;
}
