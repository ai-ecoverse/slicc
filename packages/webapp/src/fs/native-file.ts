/**
 * Resolve a VFS-relative path to the native `File` behind a
 * `FileSystemDirectoryHandle` tree (OPFS root or an FSA picker mount).
 *
 * A `File` is a lazy handle: `slice()`/`FileReaderSync` read only the
 * bytes asked for, so a consumer that can mount one — ffmpeg's WORKERFS,
 * mediabunny's `BlobSource` — never holds the whole file in memory. That
 * is the difference between "any input the wasm heap can hold twice" and
 * "any input on disk" for media commands.
 *
 * Returns `null` for anything that is not a plain file at that path
 * (missing, a directory, a handle the browser refuses); callers fall back
 * to a whole-file read. Never throws.
 */
export async function fileFromDirectoryHandle(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<File | null> {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  if (name === undefined) return null;
  try {
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const fh = await dir.getFileHandle(name);
    return await fh.getFile();
  } catch {
    return null;
  }
}
