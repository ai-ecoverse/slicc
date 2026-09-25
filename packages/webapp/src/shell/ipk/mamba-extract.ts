/**
 * Extract conda package archives (`.tar.bz2`, and `.conda` when present) into
 * a list of path/bytes entries suitable for writing into the VFS prefix.
 *
 * emscripten-forge-4x currently ships only `.tar.bz2`; `.conda` (zip + zstd)
 * is rejected with a clear error until a zstd decompressor is wired.
 */

import bzip2 from 'bzip2';
import { gunzip, readTar, type TarEntry } from './tar.js';

export interface ExtractedCondaEntry {
  path: string;
  bytes: Uint8Array;
  directory?: boolean;
  /** Relative symlink target when this entry is a symbolic link. */
  symlink?: string;
}

function assertSafeRelPath(path: string, label: string): string {
  const safe = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!safe || safe.split('/').some((seg) => seg === '..')) {
    throw new Error(`${label}: refusing to extract entry escaping package root: ${path}`);
  }
  return safe;
}

function tarEntriesToExtracted(entries: TarEntry[], label: string): ExtractedCondaEntry[] {
  const out: ExtractedCondaEntry[] = [];
  for (const entry of entries) {
    if (!entry.path) continue;
    const path = assertSafeRelPath(entry.path, label);
    if (entry.symlink !== undefined) {
      // Relative targets must stay inside the package tree; absolute targets
      // are rare in conda builds but are passed through as-is after a `..` check.
      if (entry.symlink.split('/').some((seg) => seg === '..')) {
        throw new Error(`${label}: refusing symlink '${path}' -> '${entry.symlink}' (path escape)`);
      }
      out.push({ path, bytes: new Uint8Array(0), symlink: entry.symlink });
      continue;
    }
    out.push({
      path,
      bytes: entry.bytes,
      ...(entry.directory ? { directory: true } : {}),
    });
  }
  return out;
}

/** Decompress a bzip2 stream to raw bytes (pure JS, no Node Buffer). */
export function bunzip2(input: Uint8Array): Uint8Array {
  if (!(input instanceof Uint8Array)) {
    throw new Error('bunzip2: input must be a Uint8Array');
  }
  if (input.length < 4 || input[0] !== 0x42 || input[1] !== 0x5a) {
    throw new Error('bunzip2: input is not a valid bzip2 stream (bad magic)');
  }
  try {
    const decoded = bzip2.simple(bzip2.array(input));
    return Uint8Array.from(decoded);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`bunzip2: failed to decompress (${reason})`);
  }
}

/**
 * Extract a conda package archive into relative path entries.
 * Supports `.tar.bz2` and plain `.tar` / `.tar.gz` (for fixtures).
 * Symlinks are preserved (`symlink` field) so the installer can recreate them.
 */
export function extractCondaArchive(bytes: Uint8Array, filename: string): ExtractedCondaEntry[] {
  const lower = filename.toLowerCase();
  const label = `extractCondaArchive(${filename})`;

  if (lower.endsWith('.conda')) {
    throw new Error(
      `${label}: .conda (zip+zstd) packages are not supported yet; ` +
        `emscripten-forge currently ships .tar.bz2 — use that format`
    );
  }

  let tarBytes: Uint8Array;
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
    tarBytes = bunzip2(bytes);
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    tarBytes = gunzip(bytes);
  } else if (lower.endsWith('.tar')) {
    tarBytes = bytes;
  } else {
    throw new Error(`${label}: unsupported archive type (expected .tar.bz2, .tar.gz, or .tar)`);
  }

  const entries = readTar(tarBytes, {
    stripNpmPrefix: false,
    includeDirectories: false,
    includeSymlinks: true,
    preserveRawPaths: false,
  });
  return tarEntriesToExtracted(entries, label);
}
