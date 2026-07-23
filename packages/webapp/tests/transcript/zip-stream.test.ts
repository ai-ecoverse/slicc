/**
 * Unit tests for zip-stream.ts — streaming fflate ZIP with digest.
 *
 * TDD RED phase: all tests written before production code exists.
 */

import { TranscriptExportError } from '@slicc/shared-ts';
import { strFromU8, unzipSync } from 'fflate';
import { sha256 } from 'js-sha256';
import { describe, expect, it } from 'vitest';
import { createTranscriptZip } from '../../src/transcript/zip-stream.js';
import { makeTranscriptDocument } from './fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bytes = (values: number[]): Uint8Array => Uint8Array.from(values);

async function collectChunks(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: number[] = [];
  for await (const chunk of chunks) parts.push(...chunk);
  return Uint8Array.from(parts);
}

// ---------------------------------------------------------------------------
// Core ZIP creation tests
// ---------------------------------------------------------------------------

describe('createTranscriptZip', () => {
  it('streams transcript.json and attachments with a verified digest', async () => {
    const document = makeTranscriptDocument();
    const result = createTranscriptZip(
      document,
      new Map([['attachments/att-0001.bin', bytes([0, 1, 2])]])
    );

    const archive = await collectChunks(result.chunks);
    const completion = await result.completion;

    expect(completion.byteLength).toBe(archive.length);
    expect(completion.sha256).toBe(sha256(archive));

    const files = unzipSync(archive);
    expect(JSON.parse(strFromU8(files['transcript.json']!))).toEqual(document);
    expect(files['attachments/att-0001.bin']).toEqual(bytes([0, 1, 2]));
  });

  it('includes only transcript.json when bundleFiles is empty', async () => {
    const document = makeTranscriptDocument();
    const result = createTranscriptZip(document, new Map());

    const archive = await collectChunks(result.chunks);
    const completion = await result.completion;

    expect(completion.byteLength).toBe(archive.length);
    expect(completion.sha256).toBe(sha256(archive));

    const files = unzipSync(archive);
    expect(Object.keys(files)).toEqual(['transcript.json']);
  });

  it('passes binary attachments through unchanged (byte equality)', async () => {
    const binaryPayload = bytes([0xff, 0x00, 0xab, 0xcd, 0x12, 0x34]);
    const document = makeTranscriptDocument();
    const result = createTranscriptZip(
      document,
      new Map([['attachments/att-0001.bin', binaryPayload]])
    );

    const archive = await collectChunks(result.chunks);
    const files = unzipSync(archive);

    expect(files['attachments/att-0001.bin']).toEqual(binaryPayload);
  });

  it('handles multiple attachments at different paths', async () => {
    const document = makeTranscriptDocument();
    const attach1 = bytes([1, 2, 3]);
    const attach2 = bytes([4, 5, 6]);
    const result = createTranscriptZip(
      document,
      new Map([
        ['attachments/att-0001.bin', attach1],
        ['attachments/att-0002.bin', attach2],
      ])
    );

    const archive = await collectChunks(result.chunks);
    const files = unzipSync(archive);

    expect(files['attachments/att-0001.bin']).toEqual(attach1);
    expect(files['attachments/att-0002.bin']).toEqual(attach2);
  });

  it('produces a filename based on document metadata', () => {
    const document = makeTranscriptDocument();
    const result = createTranscriptZip(document, new Map());
    expect(result.filename).toMatch(/\.zip$/);
    expect(result.filename.length).toBeGreaterThan(4);
  });

  it('completion resolves after all chunks are yielded', async () => {
    const document = makeTranscriptDocument();
    const result = createTranscriptZip(document, new Map());

    // Drain chunks first
    const archive = await collectChunks(result.chunks);

    // Completion must be resolved (not pending) after chunks are drained
    const completion = await result.completion;
    expect(completion.byteLength).toBe(archive.length);
  });

  it('sha256 matches independent hash of concatenated chunks', async () => {
    const document = makeTranscriptDocument();
    const attachment = new TextEncoder().encode('hello world');
    const result = createTranscriptZip(
      document,
      new Map([['attachments/att-0001.txt', attachment]])
    );

    const archive = await collectChunks(result.chunks);
    const completion = await result.completion;

    // Verify against independently computed hash
    const expected = sha256(archive);
    expect(completion.sha256).toBe(expected);
    expect(completion.byteLength).toBe(archive.length);
  });
});

// ---------------------------------------------------------------------------
// Path safety tests
// ---------------------------------------------------------------------------

describe('createTranscriptZip — path safety', () => {
  it('rejects bundle paths with path traversal (..)', () => {
    const document = makeTranscriptDocument();
    expect(() =>
      createTranscriptZip(document, new Map([['attachments/../evil.bin', bytes([1])]]))
    ).toThrow(TranscriptExportError);
  });

  it('rejects absolute bundle paths', () => {
    const document = makeTranscriptDocument();
    expect(() =>
      createTranscriptZip(document, new Map([['/absolute/path.bin', bytes([1])]]))
    ).toThrow(TranscriptExportError);
  });

  it('rejects paths with empty segments (double slash)', () => {
    const document = makeTranscriptDocument();
    expect(() =>
      createTranscriptZip(document, new Map([['attachments//att-0001.bin', bytes([1])]]))
    ).toThrow(TranscriptExportError);
  });

  it('rejects paths with null bytes', () => {
    const document = makeTranscriptDocument();
    expect(() =>
      createTranscriptZip(document, new Map([['attachments/att\0.bin', bytes([1])]]))
    ).toThrow(TranscriptExportError);
  });

  it('rejects bundle paths containing backslashes (zip-slip on Windows unzippers)', () => {
    const document = makeTranscriptDocument();
    // Backslash-only traversal
    expect(() =>
      createTranscriptZip(document, new Map([['attachments\\..\\evil.bin', bytes([1])]]))
    ).toThrow(TranscriptExportError);
    // Backslash path component
    expect(() =>
      createTranscriptZip(document, new Map([['attachments\\secret.bin', bytes([1])]]))
    ).toThrow(TranscriptExportError);
  });

  it('rejects zip-slip paths with mixed separators', () => {
    const document = makeTranscriptDocument();
    // Mixed backslash + forward-slash traversal
    expect(() =>
      createTranscriptZip(document, new Map([['attachments/..\\evil.bin', bytes([1])]]))
    ).toThrow(TranscriptExportError);
  });

  it('accepts safe nested paths', async () => {
    const document = makeTranscriptDocument();
    const result = createTranscriptZip(
      document,
      new Map([['attachments/subdir/att-0001.bin', bytes([1, 2, 3])]])
    );
    const archive = await collectChunks(result.chunks);
    const files = unzipSync(archive);
    expect(files['attachments/subdir/att-0001.bin']).toEqual(bytes([1, 2, 3]));
  });
});

// ---------------------------------------------------------------------------
// Cancellation tests
// ---------------------------------------------------------------------------

describe('createTranscriptZip — cancellation', () => {
  it('chunks throws transfer-aborted when signal is already aborted (pre-abort)', async () => {
    const controller = new AbortController();
    controller.abort();

    const document = makeTranscriptDocument();
    const result = createTranscriptZip(document, new Map(), controller.signal);
    // Suppress the completion rejection so it doesn't become an unhandled rejection.
    result.completion.catch(() => undefined);

    await expect(collectChunks(result.chunks)).rejects.toMatchObject({
      code: 'transfer-aborted',
    });
  });

  it('completion rejects with transfer-aborted on pre-abort (not just chunks)', async () => {
    const controller = new AbortController();
    controller.abort();

    const document = makeTranscriptDocument();
    const result = createTranscriptZip(document, new Map(), controller.signal);

    // Observe both concurrently — completion rejects as soon as the generator
    // starts (the abort listener fires first). Awaiting them sequentially would
    // leave completion unobserved for a tick and trigger an unhandled-rejection.
    const [chunksOutcome, completionOutcome] = await Promise.allSettled([
      collectChunks(result.chunks),
      result.completion,
    ]);

    expect(chunksOutcome.status).toBe('rejected');
    expect((chunksOutcome as PromiseRejectedResult).reason).toMatchObject({
      code: 'transfer-aborted',
    });
    expect(completionOutcome.status).toBe('rejected');
    expect((completionOutcome as PromiseRejectedResult).reason).toMatchObject({
      code: 'transfer-aborted',
    });
  });

  it('completion rejects when signal aborts during consumption (mid-stream)', async () => {
    const controller = new AbortController();

    const document = makeTranscriptDocument();
    const result = createTranscriptZip(document, new Map(), controller.signal);

    // Abort after createTranscriptZip returns but before the consumer finishes.
    controller.abort();

    // Observe both promises concurrently so neither is ever unobserved
    // (an unobserved rejected promise would trigger a vitest unhandled-rejection warning).
    const [chunksOutcome, completionOutcome] = await Promise.allSettled([
      collectChunks(result.chunks),
      result.completion,
    ]);

    expect(chunksOutcome.status).toBe('rejected');
    expect((chunksOutcome as PromiseRejectedResult).reason).toMatchObject({
      code: 'transfer-aborted',
    });
    expect(completionOutcome.status).toBe('rejected');
    expect((completionOutcome as PromiseRejectedResult).reason).toMatchObject({
      code: 'transfer-aborted',
    });
  });

  it('completion resolves only after all chunks are consumed (normal path)', async () => {
    const document = makeTranscriptDocument();
    const result = createTranscriptZip(
      document,
      new Map([['attachments/a.bin', bytes([1, 2, 3])]])
    );

    // Collect all chunks THEN await completion.
    const archive = await collectChunks(result.chunks);
    const completion = await result.completion;

    expect(completion.byteLength).toBe(archive.length);
    expect(completion.sha256).toBe(sha256(archive));
  });
});

// ---------------------------------------------------------------------------
// Filename collision-safety tests (wave 2, item 4)
// ---------------------------------------------------------------------------

describe('createTranscriptZip — filename collision-safety', () => {
  it('includes export ID prefix so same-day exports have unique names', () => {
    const base = makeTranscriptDocument();
    // Two documents with different export IDs simulate separate export invocations.
    const doc1 = {
      ...base,
      export: { ...base.export, id: 'aaaaaaaa-0000-0000-0000-000000000001' },
    };
    const doc2 = {
      ...base,
      export: { ...base.export, id: 'bbbbbbbb-0000-0000-0000-000000000002' },
    };
    const r1 = createTranscriptZip(doc1, new Map());
    const r2 = createTranscriptZip(doc2, new Map());
    // Both should be .zip files
    expect(r1.filename).toMatch(/\.zip$/);
    expect(r2.filename).toMatch(/\.zip$/);
    // Different export IDs → different filenames
    expect(r1.filename).not.toBe(r2.filename);
    // Each filename embeds its own export ID prefix
    expect(r1.filename).toContain('aaaaaaaa');
    expect(r2.filename).toContain('bbbbbbbb');
  });

  it('filename contains the first 8 chars of the export ID', () => {
    const base = makeTranscriptDocument();
    const exportId = 'cafecafe-1234-5678-abcd-ef0123456789';
    const doc = { ...base, export: { ...base.export, id: exportId } };
    const { filename } = createTranscriptZip(doc, new Map());
    // The export ID prefix (8 chars before the first dash) must appear in the filename
    const idPrefix = exportId.slice(0, 8); // 'cafecafe'
    expect(filename).toContain(idPrefix);
    expect(filename).toMatch(/\.zip$/);
  });
});
