import { gunzipSync, gzipSync } from 'fflate';
import { createTar, parseTar } from 'nanotar';

export interface TarEntry {
  path: string;
  bytes: Uint8Array;
  directory?: boolean;
  /** Permission bits (`0o755`), from the header on read; written when set. */
  mode?: number;
  /** Modification time in whole seconds since the epoch (the header's mtime). */
  mtime?: number;
}

export interface ReadTarOptions {
  stripNpmPrefix?: boolean;
  includeDirectories?: boolean;
  preserveRawPaths?: boolean;
}

const NPM_PREFIX = 'package/';

function exactByteView(input: Uint8Array): Uint8Array {
  if (input.byteOffset === 0 && input.byteLength === input.buffer.byteLength) return input;
  return new Uint8Array(input);
}

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

export function gzip(input: Uint8Array): Uint8Array {
  if (!(input instanceof Uint8Array)) {
    throw new Error('gzip: input must be a Uint8Array');
  }
  try {
    return gzipSync(input);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`gzip: failed to compress (${reason})`);
  }
}

export function writeTar(entries: TarEntry[]): Uint8Array {
  if (!Array.isArray(entries)) {
    throw new Error('writeTar: entries must be an array');
  }
  try {
    const names = entries.map((entry) => encodeTarPath(entry.path));
    const archive = createTar(
      entries.map((entry, i) => ({
        name: names[i].name,
        ...(entry.directory ? {} : { data: entry.bytes }),
        // nanotar would default to 664/775 (group-writable).
        attrs: {
          mode: (entry.mode ?? (entry.directory ? 0o755 : 0o644)).toString(8),
          // nanotar takes milliseconds here but reads seconds back.
          ...(entry.mtime === undefined ? {} : { mtime: entry.mtime * 1000 }),
        },
      }))
    );
    return applyLongPaths(archive, names);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`writeTar: failed to create tar archive (${reason})`);
  }
}

// nanotar's createTar writes only the 100-byte name field and truncates a
// longer path, so `tar c` silently renamed deep files (a CMake object tree's
// `…/Statistics/ChannelPerceptualHash.c.o` lost its tail). A path over 100
// bytes is split across the ustar prefix (155 bytes) and name fields at a
// `/`; one that doesn't fit that way gets a PAX `path` record. The reader
// below already resolves both.

const TAR_BLOCK = 512;
const NAME_FIELD = 100;
const PREFIX_FIELD = 155;
const utf8 = new TextEncoder();

interface EncodedTarPath {
  /** What nanotar writes into the name field. */
  name: string;
  /** Goes into the ustar prefix field. */
  prefix?: string;
  /** The full path, carried by a PAX record ahead of the entry. */
  pax?: string;
}

function byteLength(text: string): number {
  return utf8.encode(text).length;
}

/** Encode `path` for a ustar header: as is, prefix + name, or via PAX. */
export function encodeTarPath(path: string): EncodedTarPath {
  if (byteLength(path) <= NAME_FIELD) return { name: path };
  // The first `/` that leaves a name that fits: the shortest prefix.
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const name = path.slice(i + 1);
    const prefix = path.slice(0, i);
    if (name !== '' && byteLength(name) <= NAME_FIELD) {
      return byteLength(prefix) <= PREFIX_FIELD
        ? { name, prefix }
        : { name: tail(path), pax: path };
    }
  }
  return { name: tail(path), pax: path };
}

/** The last bytes of `path` that fit the name field, for readers without PAX. */
function tail(path: string): string {
  let name = path;
  while (byteLength(name) > NAME_FIELD) name = name.slice(1);
  return name;
}

function writeField(header: Uint8Array, offset: number, size: number, text: string): void {
  header.fill(0, offset, offset + size);
  header.set(utf8.encode(text).subarray(0, size), offset);
}

function writeChecksum(header: Uint8Array): void {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  writeField(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
}

/** A PAX record: `<length> path=<value>\n`, the length counting itself. */
function paxRecord(key: string, value: string): Uint8Array {
  const body = ` ${key}=${value}\n`;
  let length = byteLength(body) + 1;
  while (byteLength(`${length}${body}`) !== length) length = byteLength(`${length}${body}`);
  return utf8.encode(`${length}${body}`);
}

/** A typeflag `x` header plus its padded data blocks for `path`. */
function paxBlocks(path: string): Uint8Array {
  const record = paxRecord('path', path);
  const blocks = new Uint8Array(TAR_BLOCK + Math.ceil(record.length / TAR_BLOCK) * TAR_BLOCK);
  const header = blocks.subarray(0, TAR_BLOCK);
  writeField(header, 0, NAME_FIELD, tail(`PaxHeaders/${path}`));
  writeField(header, 100, 8, '0000644\0');
  writeField(header, 108, 8, '0000000\0');
  writeField(header, 116, 8, '0000000\0');
  writeField(header, 124, 12, `${record.length.toString(8).padStart(11, '0')}\0`);
  writeField(header, 136, 12, '00000000000\0');
  writeField(header, 156, 1, 'x');
  writeField(header, 257, 8, 'ustar\u000000');
  writeChecksum(header);
  blocks.set(record, TAR_BLOCK);
  return blocks;
}

/** Fill in the prefix fields and PAX records nanotar can't write. */
function applyLongPaths(archive: Uint8Array, names: EncodedTarPath[]): Uint8Array {
  if (names.every((n) => !n.prefix && !n.pax)) return archive;
  const out = new Uint8Array(archive);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let copied = 0;
  for (const encoded of names) {
    const header = out.subarray(offset, offset + TAR_BLOCK);
    const size = Number.parseInt(new TextDecoder().decode(header.subarray(124, 136)), 8) || 0;
    if (encoded.prefix) {
      writeField(header, 345, PREFIX_FIELD, encoded.prefix);
      writeChecksum(header);
    }
    if (encoded.pax) {
      chunks.push(out.subarray(copied, offset), paxBlocks(encoded.pax));
      copied = offset;
    }
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  chunks.push(out.subarray(copied));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const result = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    result.set(c, at);
    at += c.length;
  }
  return result;
}

function stripNpmPrefix(path: string): string {
  return path.startsWith(NPM_PREFIX) ? path.slice(NPM_PREFIX.length) : path;
}

// nanotar's parseTar reads the entry name from the 100-byte name field only and
// never consults the ustar `prefix` field (offset 345, 155 bytes). node-tar /
// `npm pack` split long paths (100-255 chars) across prefix+name, so those files
// would otherwise extract to the wrong location. The walk below mirrors
// parseTar's iteration exactly (same size/seek math, same meta-skip rules, same
// path sanitization) and resolves the full path per entry: prefix+name for plain
// ustar entries, or the PAX/GNU long-name override verbatim (those already carry
// the full path and must NOT be prefixed). Results are zipped with parseTar's
// items by index.

function readCString(buffer: ArrayBufferLike, offset: number, size: number): string {
  const view = new Uint8Array(buffer, offset, size);
  const i = view.indexOf(0);
  return new TextDecoder().decode(i === -1 ? view : view.subarray(0, i));
}

function readOctal(buffer: ArrayBufferLike, offset: number, size: number): number {
  const view = new Uint8Array(buffer, offset, size);
  let str = '';
  for (let i = 0; i < size; i++) str += String.fromCodePoint(view[i]);
  return Number.parseInt(str, 8);
}

function parsePaxLongName(
  buffer: ArrayBufferLike,
  offset: number,
  size: number
): string | undefined {
  const dataStr = new TextDecoder().decode(new Uint8Array(buffer, offset, size));
  let path: string | undefined;
  let linkpath: string | undefined;
  for (const line of dataStr.split('\n')) {
    const s = line.split(' ')[1]?.split('=');
    if (s) {
      if (s[0] === 'path') path = s[1];
      else if (s[0] === 'linkpath') linkpath = s[1];
    }
  }
  return path || linkpath;
}

// Mirror of nanotar's _sanitizePath so resolved paths normalize identically.
function sanitizePath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  normalized = normalized.replace(/^[a-zA-Z]:\//, '');
  normalized = normalized.replace(/^\/+/, '');
  const hasLeadingDotSlash = normalized.startsWith('./');
  const parts = normalized.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.' && part !== '') resolved.push(part);
  }
  let result = resolved.join('/');
  if (hasLeadingDotSlash && !result.startsWith('./')) result = './' + result;
  if (path.endsWith('/') && !result.endsWith('/')) result += '/';
  return result;
}

// Walk the archive the same way nanotar does, producing one resolved full path
// per emitted item (1:1 with parseTar's output order, including meta entries
// like directories/symlinks that parseTar also emits).
function resolveUstarPaths(input: Uint8Array, preserveRawPaths: boolean): string[] {
  const buffer = input.buffer;
  const names: string[] = [];
  let offset = 0;
  let nextLongName: string | undefined;
  while (offset < buffer.byteLength - 512) {
    const name = readCString(buffer, offset, 100);
    if (name.length === 0) break;
    const size = readOctal(buffer, offset + 124, 12);
    const seek = 512 + 512 * Math.trunc(size / 512) + (size % 512 ? 512 : 0);
    const typeChar = readCString(buffer, offset + 156, 1) || '0';
    // PAX extended headers (next-entry override or global).
    if (typeChar === 'x' || typeChar === 'g') {
      if (typeChar === 'x') {
        nextLongName = parsePaxLongName(buffer, offset + 512, size);
      } else {
        nextLongName = undefined;
      }
      offset += seek;
      continue;
    }
    // GNU long file/link name records.
    if (typeChar === 'L' || typeChar === 'N' || typeChar === 'K') {
      nextLongName = readCString(buffer, offset + 512, size);
      offset += seek;
      continue;
    }
    let fullPath: string;
    if (nextLongName) {
      // Long-name override already carries the full path; do NOT prepend prefix.
      fullPath = nextLongName;
    } else {
      const prefix = readCString(buffer, offset + 345, 155);
      fullPath = prefix.length > 0 ? `${prefix}/${name}` : name;
    }
    names.push(preserveRawPaths ? fullPath : sanitizePath(fullPath));
    nextLongName = undefined;
    offset += seek;
  }
  return names;
}

export function readTar(input: Uint8Array, options: ReadTarOptions = {}): TarEntry[] {
  if (!(input instanceof Uint8Array)) {
    throw new Error('readTar: input must be a Uint8Array');
  }

  // nanotar reads `data.buffer` from offset zero, so bounded views (including
  // pooled Node Buffers) must be copied into an exact backing buffer first.
  const archive = exactByteView(input);
  let items;
  try {
    items = parseTar(archive);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`readTar: failed to parse tar archive (${reason})`);
  }

  const stripPrefix = options.stripNpmPrefix ?? true;
  const includeDirectories = options.includeDirectories ?? false;
  const resolvedPaths = resolveUstarPaths(archive, options.preserveRawPaths ?? false);
  // Only trust the parallel walk when it stays aligned with parseTar's items;
  // otherwise fall back to nanotar's name (no prefix) rather than mis-assign.
  const aligned = resolvedPaths.length === items.length;
  if (options.preserveRawPaths && !aligned) {
    throw new Error('readTar: raw path resolution did not align with archive entries');
  }

  const entries: TarEntry[] = [];
  items.forEach((item, index) => {
    const directory = item.type === 'directory';
    if (!directory && item.type !== 'file' && item.type !== 'contiguousFile') return;
    if (directory && !includeDirectories) return;
    const path = aligned ? resolvedPaths[index] : item.name;
    const mode = Number.parseInt(item.attrs?.mode ?? '', 8);
    entries.push({
      path: stripPrefix ? stripNpmPrefix(path) : path,
      bytes: item.data ? item.data.slice() : new Uint8Array(0),
      ...(directory ? { directory: true } : {}),
      ...(Number.isFinite(mode) ? { mode: mode & 0o777 } : {}),
      ...(typeof item.attrs?.mtime === 'number' ? { mtime: item.attrs.mtime } : {}),
    });
  });
  return entries;
}
