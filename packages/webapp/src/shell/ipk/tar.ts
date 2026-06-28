import { gunzipSync } from 'fflate';
import { parseTar } from 'nanotar';

export interface TarEntry {
  path: string;
  bytes: Uint8Array;
}

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

function stripNpmPrefix(path: string): string {
  return path.startsWith(NPM_PREFIX) ? path.slice(NPM_PREFIX.length) : path;
}

export function readTar(input: Uint8Array): TarEntry[] {
  if (!(input instanceof Uint8Array)) {
    throw new Error('readTar: input must be a Uint8Array');
  }

  let items;
  try {
    items = parseTar(input);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`readTar: failed to parse tar archive (${reason})`);
  }

  const entries: TarEntry[] = [];
  for (const item of items) {
    if (item.type !== 'file' && item.type !== 'contiguousFile') continue;
    entries.push({
      path: stripNpmPrefix(item.name),
      bytes: item.data ? item.data.slice() : new Uint8Array(0),
    });
  }
  return entries;
}
