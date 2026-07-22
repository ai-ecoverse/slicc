/**
 * Streaming ZIP packager for transcript export bundles.
 *
 * Uses fflate's streaming `Zip`, `ZipDeflate`, and `ZipPassThrough` API.
 * Production code never uses `zipSync`. The callback-based fflate API is
 * bridged to an `AsyncIterable<Uint8Array>` via an in-memory chunk queue.
 * An incremental SHA-256 (js-sha256) is updated in the `ondata` callback so
 * `completion` resolves with authoritative byte count and digest after the
 * final ZIP chunk is emitted.
 */

import { type TranscriptDocumentV1, TranscriptExportError } from '@slicc/shared-ts';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
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
// Path safety
// ---------------------------------------------------------------------------

/**
 * Returns true only for safe bundle-relative paths.
 *
 * Rejects: absolute paths, path traversal (`..`), empty segments, null bytes.
 */
function isSafeBundlePath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith('/')) return false;
  if (path.includes('\0')) return false;
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
  const slug = document.session.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `slicc-${date}-${slug || 'transcript'}.zip`;
}

// ---------------------------------------------------------------------------
// Async chunk queue
// ---------------------------------------------------------------------------

interface ChunkQueue {
  /** Pending chunks not yet consumed by the generator. */
  items: Uint8Array[];
  done: boolean;
  error: Error | null;
  /** Resolve function for the currently-awaiting generator (if any). */
  wake: (() => void) | null;
}

function enqueue(q: ChunkQueue, chunk: Uint8Array): void {
  q.items.push(chunk);
  const wake = q.wake;
  if (wake) {
    q.wake = null;
    wake();
  }
}

function finishQueue(q: ChunkQueue): void {
  q.done = true;
  const wake = q.wake;
  if (wake) {
    q.wake = null;
    wake();
  }
}

function failQueue(q: ChunkQueue, err: Error): void {
  q.error = err;
  const wake = q.wake;
  if (wake) {
    q.wake = null;
    wake();
  }
}

async function* drainQueue(q: ChunkQueue, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  while (true) {
    if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
    if (q.error) throw q.error;
    if (q.items.length > 0) {
      yield q.items.shift()!;
      continue;
    }
    if (q.done) break;
    // Nothing available yet — wait for the next enqueue/finish/fail call.
    await new Promise<void>((res) => {
      q.wake = res;
    });
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a streaming ZIP archive for a transcript bundle.
 *
 * - `transcript.json` is compressed with DEFLATE level 6.
 * - Binary bundle files are stored without compression (ZipPassThrough).
 * - Text bundle files (identified by path extension) use DEFLATE.
 * - `completion` resolves with the authoritative byte count and SHA-256
 *   after the final ZIP chunk is emitted, regardless of when the caller
 *   drains `chunks`.
 *
 * Throws `TranscriptExportError('schema-invalid')` synchronously if any
 * bundle file path fails the safety check.
 */
export function createTranscriptZip(
  document: TranscriptDocumentV1,
  bundleFiles: Map<string, Uint8Array>,
  signal?: AbortSignal
): TranscriptZipResult {
  // Validate all bundle paths eagerly (synchronous, no ZIP chunks emitted on failure).
  for (const path of bundleFiles.keys()) {
    if (!isSafeBundlePath(path)) {
      throw new TranscriptExportError('schema-invalid');
    }
  }

  const queue: ChunkQueue = { items: [], done: false, error: null, wake: null };
  const hasher = sha256.create();
  let byteLength = 0;

  let completionResolve!: (result: { byteLength: number; sha256: string }) => void;
  let completionReject!: (err: Error) => void;
  const completion = new Promise<{ byteLength: number; sha256: string }>((res, rej) => {
    completionResolve = res;
    completionReject = rej;
  });

  const zip = new Zip((err, data, final) => {
    if (err) {
      failQueue(queue, err);
      completionReject(err);
      return;
    }
    hasher.update(data);
    byteLength += data.length;
    enqueue(queue, data);
    if (final) {
      finishQueue(queue);
      completionResolve({ byteLength, sha256: hasher.hex() });
    }
  });

  // Add transcript.json (DEFLATE — text compresses well).
  const jsonBytes = new TextEncoder().encode(JSON.stringify(document, null, 2));
  const jsonEntry = new ZipDeflate('transcript.json', { level: 6 });
  zip.add(jsonEntry);
  jsonEntry.push(jsonBytes, true);

  // Add bundle files. Text files get DEFLATE; binary files pass through.
  for (const [path, bytes] of bundleFiles) {
    const isText = /\.(?:txt|md|json|csv|xml|ya?ml|js|mjs|cjs|ts|tsx|css|html)$/i.test(path);
    if (isText) {
      const entry = new ZipDeflate(path, { level: 6 });
      zip.add(entry);
      entry.push(bytes, true);
    } else {
      const entry = new ZipPassThrough(path);
      zip.add(entry);
      entry.push(bytes, true);
    }
  }

  // Signal end of archive. With synchronous ZipDeflate/ZipPassThrough, the
  // final ondata callback fires here, resolving `completion` immediately.
  zip.end();

  return {
    filename: makeFilename(document),
    chunks: drainQueue(queue, signal),
    completion,
  };
}
