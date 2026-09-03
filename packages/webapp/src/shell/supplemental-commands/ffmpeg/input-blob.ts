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

/** `VfsAdapter` adds this beyond just-bash's `IFileSystem`; mocks may not. */
interface NativeFileFs {
  getNativeFile?(path: string): Promise<File | null>;
}

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
  const native = (fs as IFileSystem & NativeFileFs).getNativeFile;
  if (typeof native === 'function') {
    try {
      const file = await native.call(fs, absPath);
      if (file) return await cloneableBlob(file, absPath, note);
    } catch {
      /* no handle for this path — read it instead */
    }
  }
  return bytesToBlob(await fs.readFileBuffer(absPath));
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
  const clones = (value: Blob): boolean => {
    try {
      probe(value);
      return true;
    } catch {
      return false;
    }
  };
  if (clones(file)) return file;
  const wrapped = new Blob([file], { type: file.type });
  if (clones(wrapped)) {
    note?.(`ffmpeg: ${label}: native File is not transferable to the worker; wrapped it in a Blob`);
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
