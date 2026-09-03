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
export async function readInputBlob(fs: IFileSystem, absPath: string): Promise<Blob> {
  const native = (fs as IFileSystem & NativeFileFs).getNativeFile;
  if (typeof native === 'function') {
    try {
      const file = await native.call(fs, absPath);
      if (file) return file;
    } catch {
      /* no handle for this path — read it instead */
    }
  }
  return bytesToBlob(await fs.readFileBuffer(absPath));
}

/** Wrap bytes without copying. VFS reads are ArrayBuffer-backed. */
export function bytesToBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>]);
}
