/**
 * Minimal single-entry `.npz` / `.npy` reader — the PURE weight layer the
 * German on-device engine (`german-kokoro-engine.ts`) uses to pull the
 * `martin` style matrix out of `voices-martin.npz`.
 *
 * A `.npz` is a ZIP container of `.npy` arrays. The community German model
 * stores its single `martin.npy` entry STORED (uncompressed) — exactly what
 * `numpy.savez` (not `savez_compressed`) produces — so this reader handles the
 * STORED case only and throws an actionable error if it ever meets a DEFLATE
 * entry (no inflate dependency is pulled into the browser bundle for a file we
 * control). `.npy` v1.0 (2-byte header len) and v2.0 (4-byte) are both parsed;
 * only little-endian float32 (`<f4`) C-order arrays are accepted — the Kokoro
 * voice format.
 *
 * Pure + synchronous: input is the raw bytes, output is `{ shape, data }`. No
 * VFS, no I/O — the engine reads the bytes and hands them here, so the parse is
 * directly unit-testable against fixture buffers.
 */

/** A decoded float32 ndarray: its dimensions and the flat C-order data. */
export interface NpyFloat32Array {
  shape: number[];
  data: Float32Array;
}

const ZIP_LOCAL_HEADER_SIG = 0x04034b50; // 'PK\x03\x04', little-endian
const NPY_MAGIC = '\x93NUMPY';

/** True ISO-8859-1 byte→codepoint decode. `TextDecoder('latin1')` is an alias
 *  for windows-1252, which remaps 0x93 (the npy magic's first byte) to U+201C —
 *  so the raw 1:1 mapping is required for the magic + ASCII header. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Copy a byte range onto a fresh, 4-byte-aligned ArrayBuffer so a `Float32Array`
 *  view is valid regardless of the source offset's alignment. */
function alignedFloat32(bytes: Uint8Array, offset: number, byteLength: number): Float32Array {
  const buf = new ArrayBuffer(byteLength);
  new Uint8Array(buf).set(bytes.subarray(offset, offset + byteLength));
  return new Float32Array(buf);
}

/** Parse one `.npy` array (v1.0/v2.0, little-endian C-order float32). */
export function parseNpy(bytes: Uint8Array): NpyFloat32Array {
  const magic = latin1(bytes.subarray(0, 6));
  if (magic !== NPY_MAGIC) throw new Error('npz: not a .npy array (bad magic)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  let headerLen: number;
  let headerStart: number;
  if (major >= 2) {
    headerLen = view.getUint32(8, true);
    headerStart = 12;
  } else {
    headerLen = view.getUint16(8, true);
    headerStart = 10;
  }
  const header = latin1(bytes.subarray(headerStart, headerStart + headerLen));
  const descr = /'descr':\s*'([^']*)'/.exec(header)?.[1];
  if (!descr || !/^[<|=]f4$/.test(descr)) {
    throw new Error(`npz: unsupported dtype ${descr ?? '(none)'} — only little-endian <f4`);
  }
  if (/'fortran_order':\s*True/.test(header)) {
    throw new Error('npz: fortran_order arrays are not supported');
  }
  const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(header);
  if (!shapeMatch) throw new Error('npz: missing shape in .npy header');
  const shape = shapeMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10));
  if (shape.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`npz: invalid shape (${shapeMatch[1]})`);
  }
  const count = shape.reduce((acc, n) => acc * n, 1);
  const dataStart = headerStart + headerLen;
  const needed = count * 4;
  if (bytes.byteLength - dataStart < needed) {
    throw new Error('npz: truncated .npy data');
  }
  return { shape, data: alignedFloat32(bytes, dataStart, needed) };
}

/**
 * Read the (single) entry out of a STORED `.npz` ZIP and decode it as a
 * float32 array. Validates the local-file-header signature + compression method
 * and slices the contained `.npy` bytes by the header's declared size.
 */
export function parseSingleEntryNpz(bytes: Uint8Array): NpyFloat32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 30 || view.getUint32(0, true) !== ZIP_LOCAL_HEADER_SIG) {
    throw new Error('npz: not a ZIP archive (bad local file header)');
  }
  const method = view.getUint16(8, true);
  if (method !== 0) {
    throw new Error(`npz: compressed entries are not supported (method ${method}); re-save STORED`);
  }
  const compressedSize = view.getUint32(18, true);
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const entryStart = 30 + nameLen + extraLen;
  const entryEnd = entryStart + compressedSize;
  if (entryEnd > bytes.byteLength) throw new Error('npz: truncated ZIP entry');
  return parseNpy(bytes.subarray(entryStart, entryEnd));
}
