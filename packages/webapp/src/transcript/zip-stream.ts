/**
 * Streaming ZIP packager for transcript export bundles.
 *
 * Uses fflate's streaming `Zip`, `ZipDeflate`, and `ZipPassThrough` API.
 * Production code never uses `zipSync`. The callback-based fflate API is
 * bridged to an `AsyncIterable<Uint8Array>` via an in-memory chunk queue.
 *
 * `completion` resolves only after the consumer has yielded every chunk
 * (not when fflate fires the final callback), and rejects on abort or
 * fflate error. Abort listeners are cleaned up on both normal and error exit.
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
  // First 8 hex chars of the export UUID make filenames collision-safe when the
  // same session is exported multiple times on the same day. Not a security
  // token — purely a disambiguation suffix.
  const exportIdSlice = document.export.id.slice(0, 8);
  const slug = document.session.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `slicc-${date}-${slug || 'transcript'}-${exportIdSlice}.zip`;
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

// ---------------------------------------------------------------------------
// Generator — drains the queue and owns the public completion promise
// ---------------------------------------------------------------------------

/**
 * Drain the chunk queue, yielding each chunk to the consumer.
 *
 * `completion` is resolved only after the last chunk has been yielded
 * (not when fflate produces it). It rejects immediately when the signal
 * fires (even if no further iteration happens) and on fflate errors.
 * Abort listeners are removed in the `finally` block — no leaks.
 */
async function* drainQueue(
  q: ChunkQueue,
  signal: AbortSignal | undefined,
  completionResolve: (result: { byteLength: number; sha256: string }) => void,
  completionReject: (err: Error) => void,
  getZipResult: () => { byteLength: number; sha256: string } | null
): AsyncGenerator<Uint8Array> {
  // Reject completion immediately when signal is pre-aborted.
  if (signal?.aborted) {
    completionReject(new TranscriptExportError('transfer-aborted'));
    throw new TranscriptExportError('transfer-aborted');
  }

  // Abort listener: reject completion as soon as the signal fires,
  // even if the generator is suspended between yields.
  const handleAbort = (): void => {
    completionReject(new TranscriptExportError('transfer-aborted'));
  };
  signal?.addEventListener('abort', handleAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
      if (q.error) throw q.error;
      if (q.items.length > 0) {
        yield q.items.shift()!;
        continue;
      }
      if (q.done) break;
      // Wait for enqueue/finish/fail or abort (whichever comes first).
      await new Promise<void>((res) => {
        q.wake = res;
        // Wake the generator when abort fires so it can check signal.aborted.
        if (signal) signal.addEventListener('abort', () => res(), { once: true });
      });
    }
    // All chunks consumed — now resolve completion with the zip digest.
    const result = getZipResult();
    if (result) {
      completionResolve(result);
    } else {
      completionReject(new TranscriptExportError('schema-invalid'));
    }
  } catch (err) {
    // completionReject may have been called by the abort listener or fflate
    // already; calling it again is a no-op (Promise is already settled).
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
 * Create a streaming ZIP archive for a transcript bundle.
 *
 * - `transcript.json` is compressed with DEFLATE level 6.
 * - Binary bundle files are stored without compression (ZipPassThrough).
 * - Text bundle files (identified by path extension) use DEFLATE.
 * - `completion` resolves only after the consumer reaches the final chunk
 *   and rejects on abort or fflate error.
 *
 * Throws `TranscriptExportError('schema-invalid')` synchronously if any
 * bundle file path fails the safety check (including backslash traversal).
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
  let zipResult: { byteLength: number; sha256: string } | null = null;

  let completionResolve!: (result: { byteLength: number; sha256: string }) => void;
  let completionReject!: (err: Error) => void;
  const completion = new Promise<{ byteLength: number; sha256: string }>((res, rej) => {
    completionResolve = res;
    completionReject = rej;
  });

  const zip = new Zip((err, data, final) => {
    if (err) {
      failQueue(queue, err);
      // Early reject so callers waiting on completion see the error promptly
      // even if they never iterate the chunks generator.
      completionReject(err);
      return;
    }
    hasher.update(data);
    byteLength += data.length;
    enqueue(queue, data);
    if (final) {
      finishQueue(queue);
      // Store the result; the generator resolves completion after consuming.
      zipResult = { byteLength, sha256: hasher.hex() };
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

  // Signal end of archive. With synchronous ZipDeflate/ZipPassThrough, all
  // ondata callbacks fire here — chunks are queued, zipResult is set.
  zip.end();

  return {
    filename: makeFilename(document),
    chunks: drainQueue(queue, signal, completionResolve, completionReject, () => zipResult),
    completion,
  };
}
