import { FsError } from '../../fs/types.js';

export interface WholeFileFs {
  readFileBuffer(path: string): Promise<Uint8Array>;
  readFileRange?(path: string, start: number, end: number): Promise<Uint8Array>;
  stat?(path: string): Promise<{ size: number }>;
}

export const WHOLE_FILE_WINDOW_BYTES = 64 * 1024 * 1024;

export const WHOLE_FILE_MAX_BYTES = 1024 * 1024 * 1024;

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

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
    if (got < want) break;
  }
  return at === size ? out : out.slice(0, at);
}
