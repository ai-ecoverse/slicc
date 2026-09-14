import { slugify, type TranscriptDocumentV1, TranscriptExportError } from '@slicc/shared-ts';
import { sha256 } from 'js-sha256';

export interface TranscriptZipResult {
  filename: string;
  chunks: AsyncIterable<Uint8Array>;
  completion: Promise<{ byteLength: number; sha256: string }>;
}

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

const encoder = new TextEncoder();

function writeU16(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function buildLocalFileHeader(nameBytes: Uint8Array, size: number, fileCrc: number): Uint8Array {
  const hdr = new Uint8Array(30 + nameBytes.length);

  hdr[0] = 0x50;
  hdr[1] = 0x4b;
  hdr[2] = 0x03;
  hdr[3] = 0x04;
  writeU16(hdr, 4, 20);
  writeU16(hdr, 6, 0x0800);
  writeU16(hdr, 8, 0);
  writeU16(hdr, 10, 0);
  writeU16(hdr, 12, 0);
  writeU32(hdr, 14, fileCrc);
  writeU32(hdr, 18, size);
  writeU32(hdr, 22, size);
  writeU16(hdr, 26, nameBytes.length);
  writeU16(hdr, 28, 0);
  hdr.set(nameBytes, 30);
  return hdr;
}

function buildCentralDirEntry(
  nameBytes: Uint8Array,
  size: number,
  fileCrc: number,
  localOffset: number
): Uint8Array {
  const entry = new Uint8Array(46 + nameBytes.length);

  entry[0] = 0x50;
  entry[1] = 0x4b;
  entry[2] = 0x01;
  entry[3] = 0x02;
  writeU16(entry, 4, 20);
  writeU16(entry, 6, 20);
  writeU16(entry, 8, 0x0800);
  writeU16(entry, 10, 0);
  writeU16(entry, 12, 0);
  writeU16(entry, 14, 0);
  writeU32(entry, 16, fileCrc);
  writeU32(entry, 20, size);
  writeU32(entry, 24, size);
  writeU16(entry, 28, nameBytes.length);
  writeU16(entry, 30, 0);
  writeU16(entry, 32, 0);
  writeU16(entry, 34, 0);
  writeU16(entry, 36, 0);
  writeU32(entry, 38, 0);
  writeU32(entry, 42, localOffset);
  entry.set(nameBytes, 46);
  return entry;
}

function buildEOCD(entryCount: number, cdSize: number, cdOffset: number): Uint8Array {
  const eocd = new Uint8Array(22);
  eocd[0] = 0x50;
  eocd[1] = 0x4b;
  eocd[2] = 0x05;
  eocd[3] = 0x06;
  writeU16(eocd, 4, 0);
  writeU16(eocd, 6, 0);
  writeU16(eocd, 8, entryCount);
  writeU16(eocd, 10, entryCount);
  writeU32(eocd, 12, cdSize);
  writeU32(eocd, 16, cdOffset);
  writeU16(eocd, 20, 0);
  return eocd;
}

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

function makeFilename(document: TranscriptDocumentV1): string {
  const date = document.export.generatedAt.slice(0, 10);
  const exportIdSlice = document.export.id.slice(0, 8);
  const slug = slugify(document.session.title, { maxLen: 40, fallback: 'transcript' });
  return `slicc-${date}-${slug}-${exportIdSlice}.zip`;
}

interface CdEntry {
  nameBytes: Uint8Array;
  size: number;
  crc: number;
  localOffset: number;
}

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

  let completionSettled = false;

  function* emitChunk(chunk: Uint8Array): Generator<Uint8Array> {
    hasher.update(chunk);
    byteLength += chunk.byteLength;
    offset += chunk.byteLength;
    yield chunk;
  }

  try {
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

    const cdStart = offset;
    for (const entry of cdEntries) {
      if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
      yield* emitChunk(
        buildCentralDirEntry(entry.nameBytes, entry.size, entry.crc, entry.localOffset)
      );
    }

    if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
    yield* emitChunk(buildEOCD(cdEntries.length, offset - cdStart, cdStart));

    completionSettled = true;
    completionResolve({ byteLength, sha256: hasher.hex() });
  } catch (err) {
    completionSettled = true;
    completionReject(err as Error);
    throw err;
  } finally {
    signal?.removeEventListener('abort', handleAbort);

    if (!completionSettled) {
      completionSettled = true;
      completionReject(new TranscriptExportError('transfer-aborted'));
    }
  }
}

const ZIP32_MAX_FILE_BYTES = 0xffffffff;

const ZIP32_MAX_ENTRIES = 0xffff;

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

  if (bundleFiles.size + 1 > ZIP32_MAX_ENTRIES) {
    throw new TranscriptExportError('schema-invalid');
  }
  for (const data of bundleFiles.values()) {
    if (data.byteLength > ZIP32_MAX_FILE_BYTES) {
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
