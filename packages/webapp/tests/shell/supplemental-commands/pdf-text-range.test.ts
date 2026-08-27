/**
 * Page-range accounting for `extractPdfText`, against a stand-in pdf.js
 * document proxy.
 *
 * The real-PDF tests in `pdf-text.test.ts` prove WHAT comes back; these prove
 * what the extractor TOUCHED. `unpdf`'s own `extractTextItems` helper reads
 * every page of the document and keeps every page's runs, so `pdftotext -f 1
 * -l 1` on a thousand-page scan would build the lot inside the kernel worker —
 * which is why `pdf-text.ts` drives the document proxy itself.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPdfText } from '../../../src/shell/supplemental-commands/pdf-text.js';

const doc = vi.hoisted(() => ({
  numPages: 10,
  pagesRead: [] as number[],
  cleaned: 0,
  destroyed: 0,
}));

vi.mock('unpdf', () => ({
  getDocumentProxy: async () => ({
    get numPages() {
      return doc.numPages;
    },
    getPage: async (pageNumber: number) => {
      doc.pagesRead.push(pageNumber);
      return {
        getTextContent: async () => ({
          items: [
            {
              str: `page ${pageNumber}`,
              transform: [10, 0, 0, 10, 0, 0],
              width: 40,
              height: 10,
              dir: 'ltr',
              hasEOL: false,
            },
          ],
          styles: {},
        }),
        cleanup: () => {
          doc.cleaned++;
        },
      };
    },
    loadingTask: {
      destroy: async () => {
        doc.destroyed++;
      },
    },
  }),
}));

const bytes = new Uint8Array([1, 2, 3]);

describe('extractPdfText page range', () => {
  beforeEach(() => {
    doc.numPages = 10;
    doc.pagesRead = [];
    doc.cleaned = 0;
    doc.destroyed = 0;
  });

  it('reads only the requested pages, in order', async () => {
    const result = await extractPdfText(bytes, { firstPage: 3, lastPage: 5 });
    expect(doc.pagesRead).toEqual([3, 4, 5]);
    expect(result.pages).toEqual(['page 3', 'page 4', 'page 5']);
    expect(result.firstPage).toBe(3);
    expect(result.totalPages).toBe(10);
  });

  it('reads every page when no range is given', async () => {
    await extractPdfText(bytes);
    expect(doc.pagesRead).toHaveLength(10);
  });

  it('releases each page and tears the document down', async () => {
    await extractPdfText(bytes, { lastPage: 4 });
    expect(doc.cleaned).toBe(4);
    expect(doc.destroyed).toBe(1);
  });

  it('tears the document down even when extraction throws', async () => {
    await expect(extractPdfText(bytes, { firstPage: 99 })).rejects.toThrow('past the end');
    expect(doc.pagesRead).toEqual([]);
    expect(doc.destroyed).toBe(1);
  });
});
