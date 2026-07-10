import { gunzipSync, gzipSync } from 'fflate';
import { createTar, parseTar } from 'nanotar';

export interface TarEntry {
  path: string;
  bytes: Uint8Array;
  directory?: boolean;
}

export interface ReadTarOptions {
  stripNpmPrefix?: boolean;
  includeDirectories?: boolean;
  preserveRawPaths?: boolean;
}

const NPM_PREFIX = 'package/';
const TAR_NAME_FIELD_BYTES = 100;

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
  for (const entry of entries) {
    const pathBytes = new TextEncoder().encode(entry.path).byteLength;
    if (pathBytes > TAR_NAME_FIELD_BYTES) {
      throw new Error(
        `writeTar: entry path exceeds ${TAR_NAME_FIELD_BYTES} UTF-8 bytes (${pathBytes}): ${entry.path}`
      );
    }
  }
  try {
    return createTar(
      entries.map((entry) => ({
        name: entry.path,
        ...(entry.directory ? {} : { data: entry.bytes }),
      }))
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`writeTar: failed to create tar archive (${reason})`);
  }
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
    entries.push({
      path: stripPrefix ? stripNpmPrefix(path) : path,
      bytes: item.data ? item.data.slice() : new Uint8Array(0),
      ...(directory ? { directory: true } : {}),
    });
  });
  return entries;
}
