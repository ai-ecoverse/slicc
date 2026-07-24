/**
 * Pull-driven uncompressed ZIP packager for transcript export bundles.
 *
 * Replaces the fflate callback-based implementation with a standards-compliant
 * uncompressed ZIP (method 0) written as a lazy async generator. No chunk is
 * produced until the consumer pulls; at any moment at most one file's header
 * and data are in flight, keeping memory bounded.
 *
 * ZIP structure (per PKWARE Application Note APPNOTE.TXT §4.3):
 *   [Local File Header + File Data] × N   (generated lazily per consumer pull)
 *   [Central Directory Entry]       × N   (generated after all files consumed)
 *   [End of Central Directory Record]     (always 22 bytes)
 *
 * CRC-32 uses the standard IEEE 802.3 polynomial (0xEDB88320). Because all
 * bundle bytes are already in memory (bundleFiles is a Map<string, Uint8Array>),
 * CRC-32 is pre-computed before each local file header, avoiding data descriptors
 * and keeping the generator structurally simple.
 *
 * `completion` resolves only after the consumer has yielded every chunk and
 * rejects on abort or internal error. Abort listeners are cleaned up on every
 * exit path.
 */

import { type TranscriptDocumentV1, TranscriptExportError } from '@slicc/shared-ts';
import { sha256 } from 'js-sha256';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TranscriptZipResult {
  filename: string;
  chunks: AsyncIterable<Uint8Array>;
  completion: Promise<{ byteLength: number; sha256: string }>;
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, ZIP polynomial 0xEDB88320)
// ---------------------------------------------------------------------------

/** Pre-computed CRC-32 lookup table — allocated once at module load. */
const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = ~0 >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]!) & 0xff]!;
  }
  return ~crc >>> 0;
}

// ---------------------------------------------------------------------------
// ZIP structure helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Write a little-endian uint16 into `buf` at `offset`. */
function writeU16(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

/** Write a little-endian uint32 into `buf` at `offset`. */
function writeU32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

/** Build the local file header for an uncompressed entry. Returns the header bytes. */
function buildLocalFileHeader(nameBytes: Uint8Array, size: number, fileCrc: number): Uint8Array {
  const hdr = new Uint8Array(30 + nameBytes.length);
  // Signature
  hdr[0] = 0x50;
  hdr[1] = 0x4b;
  hdr[2] = 0x03;
  hdr[3] = 0x04;
  writeU16(hdr, 4, 20); // version needed (2.0)
  writeU16(hdr, 6, 0); // general purpose bit flag
  writeU16(hdr, 8, 0); // compression method (stored)
  writeU16(hdr, 10, 0); // last mod time
  writeU16(hdr, 12, 0); // last mod date
  writeU32(hdr, 14, fileCrc); // CRC-32
  writeU32(hdr, 18, size); // compressed size (= uncompressed for stored)
  writeU32(hdr, 22, size); // uncompressed size
  writeU16(hdr, 26, nameBytes.length); // filename length
  writeU16(hdr, 28, 0); // extra field length
  hdr.set(nameBytes, 30);
  return hdr;
}

/** Build a central directory entry for the given file. */
function buildCentralDirEntry(
  nameBytes: Uint8Array,
  size: number,
  fileCrc: number,
  localOffset: number
): Uint8Array {
  const entry = new Uint8Array(46 + nameBytes.length);
  // Signature
  entry[0] = 0x50;
  entry[1] = 0x4b;
  entry[2] = 0x01;
  entry[3] = 0x02;
  writeU16(entry, 4, 20); // version made by
  writeU16(entry, 6, 20); // version needed
  writeU16(entry, 8, 0); // general purpose bit flag
  writeU16(entry, 10, 0); // compression method (stored)
  writeU16(entry, 12, 0); // last mod time
  writeU16(entry, 14, 0); // last mod date
  writeU32(entry, 16, fileCrc); // CRC-32
  writeU32(entry, 20, size); // compressed size
  writeU32(entry, 24, size); // uncompressed size
  writeU16(entry, 28, nameBytes.length); // filename length
  writeU16(entry, 30, 0); // extra field length
  writeU16(entry, 32, 0); // file comment length
  writeU16(entry, 34, 0); // disk number start
  writeU16(entry, 36, 0); // internal file attributes
  writeU32(entry, 38, 0); // external file attributes
  writeU32(entry, 42, localOffset); // relative offset of local header
  entry.set(nameBytes, 46);
  return entry;
}

/** Build the End of Central Directory record. */
function buildEOCD(entryCount: number, cdSize: number, cdOffset: number): Uint8Array {
  const eocd = new Uint8Array(22);
  eocd[0] = 0x50;
  eocd[1] = 0x4b;
  eocd[2] = 0x05;
  eocd[3] = 0x06;
  writeU16(eocd, 4, 0); // disk number
  writeU16(eocd, 6, 0); // disk with CD start
  writeU16(eocd, 8, entryCount); // entries on this disk
  writeU16(eocd, 10, entryCount); // total entries
  writeU32(eocd, 12, cdSize); // CD size in bytes
  writeU32(eocd, 16, cdOffset); // CD offset from start of archive
  writeU16(eocd, 20, 0); // comment length
  return eocd;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Returns true only for safe bundle-relative paths.
 *
 * Rejects: absolute paths, backslashes (zip-slip on Windows unzippers),
 * path traversal (`..`), empty segments, null bytes, and empty strings.
 */
function isSafeBundlePath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith('/')) return false;
  if (path.includes('\0')) return false;
  if (path.includes('\\')) return false;
  for (const part of path.split('/')) {
    if (part === '' || part === '.' || part === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Filename generator
// ---------------------------------------------------------------------------

function makeFilename(document: TranscriptDocumentV1): string {
  const date = document.export.generatedAt.slice(0, 10);
  const exportIdSlice = document.export.id.slice(0, 8);
  const slug = document.session.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `slicc-${date}-${slug || 'transcript'}-${exportIdSlice}.zip`;
}

// ---------------------------------------------------------------------------
// Central directory entry metadata (accumulated while iterating)
// ---------------------------------------------------------------------------

interface CdEntry {
  nameBytes: Uint8Array;
  size: number;
  crc: number;
  localOffset: number;
}

// ---------------------------------------------------------------------------
// Pull-driven ZIP generator
// ---------------------------------------------------------------------------

/**
 * Async generator that yields ZIP bytes on demand.
 *
 * Files are processed one at a time: the generator yields a local file header
 * then the raw file bytes. The central directory and EOCD follow after all
 * files are consumed. Aborting mid-stream (via `return()`) is safe.
 *
 * `completionResolve`/`completionReject` are called after the last yield.
 */
async function* generateZip(
  document: TranscriptDocumentV1,
  bundleFiles: Map<string, Uint8Array>,
  signal: AbortSignal | undefined,
  completionResolve: (r: { byteLength: number; sha256: string }) => void,
  completionReject: (e: Error) => void
): AsyncGenerator<Uint8Array> {
  if (signal?.aborted) {
    completionReject(new TranscriptExportError('transfer-aborted'));
    throw new TranscriptExportError('transfer-aborted');
  }

  const handleAbort = (): void => completionReject(new TranscriptExportError('transfer-aborted'));
  signal?.addEventListener('abort', handleAbort, { once: true });

  const hasher = sha256.create();
  let byteLength = 0;
  let offset = 0;
  const cdEntries: CdEntry[] = [];

  /** Yield a chunk: hash it, count it, track offset. */
  function* emitChunk(chunk: Uint8Array): Generator<Uint8Array> {
    hasher.update(chunk);
    byteLength += chunk.byteLength;
    offset += chunk.byteLength;
    yield chunk;
  }

  try {
    // --- transcript.json ---
    const jsonBytes = new TextEncoder().encode(JSON.stringify(document, null, 2));
    const jsonName = encoder.encode('transcript.json');
    const jsonCrc = crc32(jsonBytes);
    const jsonHdr = buildLocalFileHeader(jsonName, jsonBytes.length, jsonCrc);
    cdEntries.push({
      nameBytes: jsonName,
      size: jsonBytes.length,
      crc: jsonCrc,
      localOffset: offset,
    });
    if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
    yield* emitChunk(jsonHdr);
    if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
    yield* emitChunk(jsonBytes);

    // --- bundle files ---
    for (const [path, data] of bundleFiles) {
      if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
      const nameBytes = encoder.encode(path);
      const fileCrc = crc32(data);
      const hdr = buildLocalFileHeader(nameBytes, data.length, fileCrc);
      cdEntries.push({ nameBytes, size: data.length, crc: fileCrc, localOffset: offset });
      yield* emitChunk(hdr);
      if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
      yield* emitChunk(data);
    }

    // --- central directory ---
    const cdStart = offset;
    for (const entry of cdEntries) {
      if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
      yield* emitChunk(
        buildCentralDirEntry(entry.nameBytes, entry.size, entry.crc, entry.localOffset)
      );
    }

    // --- EOCD ---
    if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
    yield* emitChunk(buildEOCD(cdEntries.length, offset - cdStart, cdStart));

    completionResolve({ byteLength, sha256: hasher.hex() });
  } catch (err) {
    completionReject(err as Error);
    throw err;
  } finally {
    signal?.removeEventListener('abort', handleAbort);
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a pull-driven uncompressed ZIP archive for a transcript bundle.
 *
 * - `transcript.json` is stored uncompressed (method 0).
 * - All bundle files are stored without compression (method 0).
 * - CRC-32 is pre-computed from the bytes already in memory before each header.
 * - `completion` resolves only after the last chunk is yielded.
 *
 * Throws `TranscriptExportError('schema-invalid')` synchronously if any
 * bundle file path fails the safety check.
 */
export function createTranscriptZip(
  document: TranscriptDocumentV1,
  bundleFiles: Map<string, Uint8Array>,
  signal?: AbortSignal
): TranscriptZipResult {
  for (const path of bundleFiles.keys()) {
    if (!isSafeBundlePath(path)) {
      throw new TranscriptExportError('schema-invalid');
    }
  }

  let completionResolve!: (r: { byteLength: number; sha256: string }) => void;
  let completionReject!: (e: Error) => void;
  const completion = new Promise<{ byteLength: number; sha256: string }>((res, rej) => {
    completionResolve = res;
    completionReject = rej;
  });

  return {
    filename: makeFilename(document),
    chunks: generateZip(document, bundleFiles, signal, completionResolve, completionReject),
    completion,
  };
}
