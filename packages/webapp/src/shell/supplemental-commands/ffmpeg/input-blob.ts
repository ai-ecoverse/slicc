/**
 * Media inputs as lazily-readable `Blob`s.
 *
 * `ffmpeg` and `ffprobe` used to read every input into a `Uint8Array`,
 * transfer it to the wasm worker, and copy it again into MEMFS inside the
 * 2 GiB wasm heap — three copies before the first frame was decoded. A
 * `Blob` is read by slice instead: ffmpeg's WORKERFS pulls only the bytes
 * the demuxer asks for through `FileReaderSync`, and mediabunny's
 * `BlobSource` does the same asynchronously. When the VFS can hand out the
 * native `File` behind a path (OPFS root, FSA picker mount) nothing is
 * read up front at all; otherwise the bytes are read once here and the
 * resulting `Blob` still keeps them out of the wasm heap.
 */

import type { IFileSystem } from 'just-bash';

/** `VfsAdapter` adds these beyond just-bash's `IFileSystem`; mocks may not. */
interface NativeFileFs {
  getNativeFile?(path: string): Promise<File | null>;
  readFileRange?(path: string, start: number, end: number): Promise<Uint8Array>;
}

/** Bytes compared between the lazy `File` and the VFS before trusting the File. */
const VERIFY_HEAD_BYTES = 64;

/**
 * Bytes of `absPath` as a `Blob`: the VFS's native `File` when it has one,
 * else a `Blob` over a one-shot whole-file read. Throws only when the
 * fallback read does (missing file, sandbox ENOENT, read-only mount).
 */
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
    } catch {
      /* no handle for this path — read it instead */
    }
  }
  return bytesToBlob(await fs.readFileBuffer(absPath));
}

/**
 * A native `File` is a snapshot of whatever the browser's handle pointed at
 * when it was taken. Seen live: a `File` for a freshly written OPFS path
 * whose bytes did not match what the VFS itself reads (ffmpeg sniffed it as
 * a lyrics file). So before a lazy `File` is trusted, its size and first
 * {@link VERIFY_HEAD_BYTES} bytes are compared with the VFS's own view; a
 * mismatch falls back to the whole-file read and is reported. Backends
 * without a ranged read cannot be checked and are trusted.
 */
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

/** Seam for tests: the structured-clone probe. */
export type CloneProbe = (value: unknown) => void;

/**
 * The input has to cross `postMessage` into the ffmpeg worker (WORKERFS
 * mounts the Blob there). A native `File` normally clones for free — no
 * bytes move — but a `File` some backends hand out is not serializable
 * ("#<File> could not be cloned" seen live on an OPFS-rooted VFS). Probe
 * once with `structuredClone`, then degrade: a `Blob` composed OF the file
 * still reads lazily and usually clones; a whole-file read is the last
 * resort and is reported, because it costs the file's size in memory.
 */
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

/** Wrap bytes without copying. VFS reads are ArrayBuffer-backed. */
export function bytesToBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>]);
}

/** What kind of object a backend handed out — for the stderr note when it misbehaves. */
function describeBlob(value: Blob): string {
  const ctor = (value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
  const isFile = typeof File !== 'undefined' && value instanceof File;
  const isBlob = value instanceof Blob;
  return `${ctor}, instanceof File=${isFile}, instanceof Blob=${isBlob}, size=${value.size}, type=${JSON.stringify(value.type)}`;
}
