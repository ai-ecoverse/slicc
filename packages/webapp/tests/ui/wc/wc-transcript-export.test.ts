// @vitest-environment jsdom

import { TranscriptExportError } from '@slicc/shared-ts';
import { sha256 } from 'js-sha256';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptZipResult } from '../../../src/transcript/zip-stream.js';
import {
  downloadTranscriptBlob,
  transcriptZipToBlob,
} from '../../../src/ui/wc/wc-transcript-export.js';

function makeResult(
  bytes: Uint8Array,
  overrides?: Partial<TranscriptZipResult>
): TranscriptZipResult {
  return {
    filename: 'test.zip',
    chunks: (async function* () {
      yield bytes;
    })(),
    completion: Promise.resolve({
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    }),
    ...overrides,
  };
}

describe('transcriptZipToBlob', () => {
  it('collects chunks into a Blob with application/zip type', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const blob = await transcriptZipToBlob(makeResult(bytes));
    expect(blob.type).toBe('application/zip');
    expect(blob.size).toBe(4);
  });

  it('verifies byte length matches completion before returning', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const result = makeResult(bytes, {
      completion: Promise.resolve({
        byteLength: 999, // wrong
        sha256: sha256(bytes),
      }),
    });
    await expect(transcriptZipToBlob(result)).rejects.toMatchObject({
      code: 'transfer-corrupt',
    });
  });

  it('throws TranscriptExportError when byteLength mismatches', async () => {
    const bytes = Uint8Array.from([10, 20]);
    const result = makeResult(bytes, {
      completion: Promise.resolve({ byteLength: 1, sha256: sha256(bytes) }),
    });
    await expect(transcriptZipToBlob(result)).rejects.toBeInstanceOf(TranscriptExportError);
  });

  it('handles multiple chunks correctly', async () => {
    const chunk1 = Uint8Array.from([1, 2]);
    const chunk2 = Uint8Array.from([3, 4, 5]);
    const all = Uint8Array.from([1, 2, 3, 4, 5]);
    const result: TranscriptZipResult = {
      filename: 'multi.zip',
      chunks: (async function* () {
        yield chunk1;
        yield chunk2;
      })(),
      completion: Promise.resolve({ byteLength: 5, sha256: sha256(all) }),
    };
    const blob = await transcriptZipToBlob(result);
    expect(blob.size).toBe(5);
  });

  it('rejects transfer with correct length but wrong SHA-256 digest', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const wrongDigest = sha256(Uint8Array.from([4, 5, 6])); // same length, different content
    const result = makeResult(bytes, {
      completion: Promise.resolve({ byteLength: 3, sha256: wrongDigest }),
    });
    await expect(transcriptZipToBlob(result)).rejects.toMatchObject({
      code: 'transfer-corrupt',
    });
  });
});

describe('downloadTranscriptBlob', () => {
  beforeEach(() => {
    // Clean up any appended anchors from previous tests
    for (const el of document.querySelectorAll('a[data-transcript-dl]')) el.remove();
  });

  it('creates a temporary object URL and revokes it after download', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const blob = new Blob([bytes], { type: 'application/zip' });

    const createObjectURL = vi.fn(() => 'blob:test-url');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await downloadTranscriptBlob(blob, 'session.zip');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
    expect(clickSpy).toHaveBeenCalledOnce();

    clickSpy.mockRestore();
  });

  it('revokes the object URL even if click throws', async () => {
    const blob = new Blob([Uint8Array.from([1])], { type: 'application/zip' });

    const createObjectURL = vi.fn(() => 'blob:err-url');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('click failed');
    });

    await expect(downloadTranscriptBlob(blob, 'session.zip')).rejects.toThrow();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:err-url');

    clickSpy.mockRestore();
  });

  it('removes the anchor from the DOM after download', async () => {
    const blob = new Blob([Uint8Array.from([1])], { type: 'application/zip' });

    const createObjectURL = vi.fn(() => 'blob:remove-url');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      // The anchor should be in the document when click fires
      expect(document.contains(this)).toBe(true);
    });

    await downloadTranscriptBlob(blob, 'session.zip');

    // After download, the anchor should be removed
    expect(document.querySelectorAll('a[data-transcript-dl]').length).toBe(0);

    clickSpy.mockRestore();
  });
});
