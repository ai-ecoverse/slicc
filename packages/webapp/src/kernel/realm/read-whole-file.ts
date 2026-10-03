/**
 * A whole-file read for the realm's file layers, past a mount's body cap.
 *
 * The realm's programs hold a file's bytes whole: a WASI file buffer, an
 * Emscripten live node and a kernel description all load a file on first use
 * through one read. A hostfs mount refuses a whole-file read over its body cap
 * (`EFBIG`, 100 MiB, matching the bridge), so a 182 MB `rustc.wasm` could not
 * be copied, hashed or run off a mount (#3762). Its ranged read has no such
 * cap: on `EFBIG` the file is assembled here from windows of it instead.
 *
 * Only the realm reads this way. Elsewhere `EFBIG` stays the answer, so git
 * keeps its readable "pack too large" hint rather than allocating the pack.
 */
import { FsError } from '../../fs/types.js';

/** The read surface it needs: the realm's gated fs (`VfsAdapter`, sudo-fs, RestrictedFS). */
export interface WholeFileFs {
  readFileBuffer(path: string): Promise<Uint8Array>;
  readFileRange?(path: string, start: number, end: number): Promise<Uint8Array>;
  stat?(path: string): Promise<{ size: number }>;
}

/** One ranged read's window: well under the hostfs body cap. */
export const WHOLE_FILE_WINDOW_BYTES = 64 * 1024 * 1024;

/** The largest file assembled whole (the realm's sync wire carries an int32 length). */
export const WHOLE_FILE_MAX_BYTES = 1024 * 1024 * 1024;

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The bytes of `path`. A whole read first; when the backend refuses that as
 * too big and can read a range, the file in windows of `windowBytes`. A file
 * that shrinks meanwhile ends where its last window did.
 *
 * @throws the whole read's error when no ranged read can stand in for it;
 *   FsError EFBIG for a file over {@link WHOLE_FILE_MAX_BYTES}.
 */
export async function readWholeFile(
  fs: WholeFileFs,
  path: string,
  windowBytes = WHOLE_FILE_WINDOW_BYTES
): Promise<Uint8Array> {
  try {
    return await fs.readFileBuffer(path);
  } catch (err) {
    if (errnoOf(err) !== 'EFBIG' || !fs.readFileRange || !fs.stat) throw err;
    return readInWindows(fs as Required<WholeFileFs>, path, windowBytes);
  }
}

async function readInWindows(
  fs: Required<WholeFileFs>,
  path: string,
  windowBytes: number
): Promise<Uint8Array> {
  const { size } = await fs.stat(path);
  if (size > WHOLE_FILE_MAX_BYTES) {
    throw new FsError('EFBIG', 'file too large to read whole', path);
  }
  const out = new Uint8Array(size);
  let at = 0;
  while (at < size) {
    const want = Math.min(windowBytes, size - at);
    const chunk = await fs.readFileRange(path, at, at + want);
    const got = Math.min(chunk.byteLength, want);
    out.set(chunk.subarray(0, got), at);
    at += got;
    if (got < want) break; // shrank since the stat
  }
  return at === size ? out : out.slice(0, at);
}
