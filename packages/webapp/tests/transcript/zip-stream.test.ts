import { TranscriptExportError } from '@slicc/shared-ts';
import { strFromU8, unzipSync } from 'fflate';
import { sha256 } from 'js-sha256';
import { describe, expect, it } from 'vitest';
import { createTranscriptZip } from '../../src/transcript/zip-stream.js';
import { makeTranscriptDocument } from './fixtures.js';

const bytes = (values: number[]): Uint8Array => Uint8Array.from(values);

async function collectChunks(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: number[] = [];
  for await (const chunk of chunks) parts.push(...chunk);
  return Uint8Array.from(parts);
}

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

    const archive = await collectChunks(result.chunks);

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

    const expected = sha256(archive);
    expect(completion.sha256).toBe(expected);
    expect(completion.byteLength).toBe(archive.length);
  });
});

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

    expect(() =>
      createTranscriptZip(document, new Map([['attachments\\..\\evil.bin', bytes([1])]]))
    ).toThrow(TranscriptExportError);

    expect(() =>
      createTranscriptZip(document, new Map([['attachments\\secret.bin', bytes([1])]]))
    ).toThrow(TranscriptExportError);
  });

  it('rejects zip-slip paths with mixed separators', () => {
    const document = makeTranscriptDocument();

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

describe('createTranscriptZip — cancellation', () => {
  it('chunks throws transfer-aborted when signal is already aborted (pre-abort)', async () => {
    const controller = new AbortController();
    controller.abort();

    const document = makeTranscriptDocument();
    const result = createTranscriptZip(document, new Map(), controller.signal);

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

    controller.abort();

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

    const archive = await collectChunks(result.chunks);
    const completion = await result.completion;

    expect(completion.byteLength).toBe(archive.length);
    expect(completion.sha256).toBe(sha256(archive));
  });
});

describe('createTranscriptZip — filename collision-safety', () => {
  it('includes export ID prefix so same-day exports have unique names', () => {
    const base = makeTranscriptDocument();

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

    expect(r1.filename).toMatch(/\.zip$/);
    expect(r2.filename).toMatch(/\.zip$/);

    expect(r1.filename).not.toBe(r2.filename);

    expect(r1.filename).toContain('aaaaaaaa');
    expect(r2.filename).toContain('bbbbbbbb');
  });

  it('slugs the session title with NFKD and trims every leading/trailing hyphen', () => {
    const base = makeTranscriptDocument();
    const accented = {
      ...base,
      session: { ...base.session, title: 'Café Ölçü' },
    };
    expect(createTranscriptZip(accented, new Map()).filename).toContain('cafe-olcu');

    const hyphenated = {
      ...base,
      session: { ...base.session, title: '--foo--' },
    };
    expect(createTranscriptZip(hyphenated, new Map()).filename).toBe(
      'slicc-2024-01-01-foo-exp-fixt.zip'
    );

    const empty = {
      ...base,
      session: { ...base.session, title: '!!!' },
    };
    expect(createTranscriptZip(empty, new Map()).filename).toBe(
      'slicc-2024-01-01-transcript-exp-fixt.zip'
    );
  });

  it('filename contains the first 8 chars of the export ID', () => {
    const base = makeTranscriptDocument();
    const exportId = 'cafecafe-1234-5678-abcd-ef0123456789';
    const doc = { ...base, export: { ...base.export, id: exportId } };
    const { filename } = createTranscriptZip(doc, new Map());

    const idPrefix = exportId.slice(0, 8);
    expect(filename).toContain(idPrefix);
    expect(filename).toMatch(/\.zip$/);
  });
});

describe('createTranscriptZip — pull-driven (Wave 4)', () => {
  it('first yielded chunk is a small header, not the whole archive', async () => {
    const bigFile = new Uint8Array(1_000_000).fill(0xaa);
    const document = makeTranscriptDocument();
    const result = createTranscriptZip(document, new Map([['big.bin', bigFile]]));

    const gen = result.chunks[Symbol.asyncIterator]();
    const first = await gen.next();
    expect(first.done).toBe(false);

    expect((first.value as Uint8Array).byteLength).toBeLessThan(32 * 1024);

    await gen.return?.();
    result.completion.catch(() => undefined);
  });

  it('generator can be abandoned early (consumer stops mid-stream)', async () => {
    const document = makeTranscriptDocument();
    const result = createTranscriptZip(
      document,
      new Map([
        ['a.bin', bytes([1, 2, 3])],
        ['b.bin', bytes([4, 5, 6])],
      ])
    );

    const gen = result.chunks[Symbol.asyncIterator]();
    const first = await gen.next();
    expect(first.done).toBe(false);

    await gen.return?.();
    result.completion.catch(() => undefined);
  });

  it('produces a valid uncompressed ZIP verified by fflate unzipSync', async () => {
    const document = makeTranscriptDocument();
    const attach = bytes([0xde, 0xad, 0xbe, 0xef]);
    const result = createTranscriptZip(document, new Map([['attachments/data.bin', attach]]));

    const archive = await collectChunks(result.chunks);
    const completion = await result.completion;

    const files = unzipSync(archive);
    expect(files['transcript.json']).toBeDefined();
    expect(files['attachments/data.bin']).toEqual(attach);
    expect(completion.byteLength).toBe(archive.length);
  });

  it('CRC32 is correct (unzipSync validates it implicitly)', async () => {
    const document = makeTranscriptDocument();
    const data = new TextEncoder().encode('hello world');
    const result = createTranscriptZip(document, new Map([['readme.txt', data]]));

    const archive = await collectChunks(result.chunks);

    const files = unzipSync(archive);
    expect(new TextDecoder().decode(files['readme.txt'])).toBe('hello world');
  });

  it('handles filenames with UTF-8 characters — exact decoded round-trip', async () => {
    const nonAsciiName = 'attachments/日本語.txt';
    const document = makeTranscriptDocument();
    const result = createTranscriptZip(
      document,
      new Map([[nonAsciiName, new TextEncoder().encode('テスト')]])
    );
    const archive = await collectChunks(result.chunks);
    await result.completion;

    const files = unzipSync(archive);
    const names = Object.keys(files);

    expect(names).toContain(nonAsciiName);
  });
});

describe('createTranscriptZip — ZIP32 overflow guards', () => {
  it('rejects when entry count (including transcript.json) exceeds 65535', () => {
    const document = makeTranscriptDocument();

    const bigMap = new Map<string, Uint8Array>();
    for (let i = 0; i < 65535; i++) {
      bigMap.set(`attachments/f${String(i).padStart(6, '0')}.bin`, bytes([i & 0xff]));
    }
    expect(() => createTranscriptZip(document, bigMap)).toThrow(TranscriptExportError);
  });

  it('rejects when a single bundle file exceeds 4 GiB', () => {
    const document = makeTranscriptDocument();

    const FOUR_GIB = 0x1_0000_0000;
    const fakeData = new Proxy(new Uint8Array(0), {
      get(target, prop) {
        if (prop === 'byteLength') return FOUR_GIB;
        // biome-ignore lint: proxy trampoline for test
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    }) as Uint8Array;
    expect(() => createTranscriptZip(document, new Map([['big.bin', fakeData]]))).toThrow(
      TranscriptExportError
    );
  });

  it('accepts exactly 65534 bundle files (65534 + transcript.json = 65535 entries)', () => {
    const document = makeTranscriptDocument();
    const bigMap = new Map<string, Uint8Array>();
    for (let i = 0; i < 65534; i++) {
      bigMap.set(`attachments/f${String(i).padStart(6, '0')}.bin`, bytes([i & 0xff]));
    }

    expect(() => createTranscriptZip(document, bigMap)).not.toThrow();
  });
});

describe('createTranscriptZip — completion rejects on early consumer exit', () => {
  it('completion rejects with transfer-aborted when consumer calls generator.return() mid-stream', async () => {
    const document = makeTranscriptDocument();
    const attach = bytes([1, 2, 3, 4, 5]);
    const result = createTranscriptZip(
      document,
      new Map([
        ['a.bin', attach],
        ['b.bin', attach],
      ])
    );

    const gen = result.chunks[Symbol.asyncIterator]();
    const first = await gen.next();
    expect(first.done).toBe(false);
    await gen.return?.();

    await expect(result.completion).rejects.toMatchObject({ code: 'transfer-aborted' });
  });
});
