import { gunzipSync } from 'fflate';

export interface TarEntry {
  path: string;
  bytes: Uint8Array;
}

const BLOCK = 512;
const NPM_PREFIX = 'package/';

export function gunzip(input: Uint8Array): Uint8Array {
  if (!(input instanceof Uint8Array)) {
    throw new Error('gunzip: input must be a Uint8Array');
  }
  if (input.length < 18 || input[0] !== 0x1f || input[1] !== 0x8b) {
    throw new Error('gunzip: input is not a valid gzip stream (bad magic)');
  }
  try {
    return gunzipSync(input);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`gunzip: failed to decompress (${reason})`);
  }
}

function readCString(buf: Uint8Array, offset: number, len: number): string {
  let end = offset;
  const limit = offset + len;
  while (end < limit && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(offset, end));
}

function readOctal(buf: Uint8Array, offset: number, len: number): number {
  let end = offset + len;
  let start = offset;
  while (start < end && (buf[start] === 0x20 || buf[start] === 0)) start++;
  while (end > start && (buf[end - 1] === 0x20 || buf[end - 1] === 0)) end--;
  if (start === end) return 0;
  let value = 0;
  for (let i = start; i < end; i++) {
    const c = buf[i];
    if (c < 0x30 || c > 0x37) {
      throw new Error(
        `readTar: invalid octal digit 0x${c.toString(16)} in header field at offset ${i}`
      );
    }
    value = value * 8 + (c - 0x30);
  }
  return value;
}

function isAllZero(buf: Uint8Array, offset: number, len: number): boolean {
  const end = offset + len;
  for (let i = offset; i < end; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

function computeChecksums(buf: Uint8Array, offset: number): { unsigned: number; signed: number } {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : buf[offset + i];
    unsigned += b;
    signed += b < 128 ? b : b - 256;
  }
  return { unsigned, signed };
}

function parsePaxRecords(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = new TextDecoder().decode(data);
  let i = 0;
  while (i < text.length) {
    const spaceIdx = text.indexOf(' ', i);
    if (spaceIdx === -1) break;
    const lenStr = text.slice(i, spaceIdx);
    const recLen = Number.parseInt(lenStr, 10);
    if (!Number.isFinite(recLen) || recLen <= 0 || i + recLen > text.length) {
      throw new Error(`readTar: malformed PAX record near offset ${i}`);
    }
    const record = text.slice(i, i + recLen);
    const eq = record.indexOf('=');
    if (eq === -1) {
      throw new Error('readTar: malformed PAX record (no key=value)');
    }
    const key = record.slice(spaceIdx - i + 1, eq);
    const value = record.slice(eq + 1, record.length - 1);
    out[key] = value;
    i += recLen;
  }
  return out;
}

function stripNpmPrefix(path: string): string {
  return path.startsWith(NPM_PREFIX) ? path.slice(NPM_PREFIX.length) : path;
}

interface TarHeader {
  name: string;
  size: number;
  typeflag: string;
  prefix: string;
}

function parseHeader(input: Uint8Array, offset: number): TarHeader {
  const storedChecksum = readOctal(input, offset + 148, 8);
  const { unsigned, signed } = computeChecksums(input, offset);
  if (storedChecksum !== unsigned && storedChecksum !== signed) {
    throw new Error(
      `readTar: invalid header checksum at offset ${offset} (corrupt or non-tar input)`
    );
  }
  const magic = readCString(input, offset + 257, 6);
  if (magic !== 'ustar' && magic !== 'ustar ') {
    throw new Error(`readTar: unsupported tar format at offset ${offset} (magic="${magic}")`);
  }
  return {
    name: readCString(input, offset, 100),
    size: readOctal(input, offset + 124, 12),
    typeflag: String.fromCharCode(input[offset + 156] || 0x30),
    prefix: readCString(input, offset + 345, 155),
  };
}

interface PendingNames {
  longName: string | null;
  paxPath: string | null;
}

function resolveFullPath(header: TarHeader, pending: PendingNames): string {
  if (pending.paxPath !== null) return pending.paxPath;
  if (pending.longName !== null) return pending.longName;
  if (header.prefix.length > 0) return `${header.prefix}/${header.name}`;
  return header.name;
}

function isRegularFile(typeflag: string): boolean {
  return typeflag === '0' || typeflag === '\0' || typeflag === '7';
}

function isEndOfArchive(input: Uint8Array, offset: number): boolean {
  return (
    isAllZero(input, offset, BLOCK) &&
    offset + 2 * BLOCK <= input.length &&
    isAllZero(input, offset + BLOCK, BLOCK)
  );
}

export function readTar(input: Uint8Array): TarEntry[] {
  if (!(input instanceof Uint8Array)) {
    throw new Error('readTar: input must be a Uint8Array');
  }
  if (input.length < BLOCK) {
    throw new Error(`readTar: input is shorter than one ${BLOCK}-byte block`);
  }

  const entries: TarEntry[] = [];
  const pending: PendingNames = { longName: null, paxPath: null };
  let offset = 0;
  let sawHeader = false;

  while (offset + BLOCK <= input.length) {
    if (isEndOfArchive(input, offset)) return entries;
    if (isAllZero(input, offset, BLOCK)) {
      offset += BLOCK;
      continue;
    }

    const header = parseHeader(input, offset);
    const dataOffset = offset + BLOCK;
    const dataEnd = dataOffset + header.size;
    if (dataEnd > input.length) {
      throw new Error(
        `readTar: truncated archive (entry at offset ${offset} declares size ${header.size}, ` +
          `but only ${input.length - dataOffset} bytes remain)`
      );
    }
    const data = input.subarray(dataOffset, dataEnd);
    offset = dataOffset + Math.ceil(header.size / BLOCK) * BLOCK;
    sawHeader = true;

    if (header.typeflag === 'L' || header.typeflag === 'K') {
      pending.longName = readCString(data, 0, data.length);
      continue;
    }
    if (header.typeflag === 'x') {
      const records = parsePaxRecords(data);
      if (typeof records.path === 'string') pending.paxPath = records.path;
      continue;
    }
    if (header.typeflag === 'g') continue;

    if (!isRegularFile(header.typeflag)) {
      pending.longName = null;
      pending.paxPath = null;
      continue;
    }

    const fullPath = resolveFullPath(header, pending);
    pending.longName = null;
    pending.paxPath = null;
    entries.push({ path: stripNpmPrefix(fullPath), bytes: data.slice() });
  }

  if (!sawHeader) {
    throw new Error('readTar: no valid tar headers found');
  }
  throw new Error('readTar: truncated archive (missing end-of-archive marker)');
}
