/**
 * `pdftk`'s `uncompress` / `compress` output options, implemented over
 * `@cantoo/pdf-lib`'s object graph.
 *
 * `uncompress` is the standard "make this PDF greppable" move — inflate every
 * stream and write a plain cross-reference table, so `grep`/`sed` can reach
 * the page operators. `compress` is its inverse, and matters because pdf-lib
 * never deflates on its own: a document that round-tripped through
 * `uncompress` stays inflated until something re-encodes it.
 */

import type { PDFDict, PDFDocument, PDFRawStream } from '@cantoo/pdf-lib';

type PdfLib = typeof import('@cantoo/pdf-lib');

export type PdfStreamMode = 'uncompress' | 'compress';

/**
 * Cross-reference and object streams are rebuilt by pdf-lib on save (the
 * parser already expanded their contents into standalone indirect objects),
 * so rewriting them here would only leave a stale second copy in the output.
 */
function isStructuralStream(pdfLib: PdfLib, dict: PDFDict): boolean {
  const type = dict.lookup(pdfLib.PDFName.of('Type'));
  // `PDFName.of` interns, so identity comparison is the idiomatic check.
  return type === pdfLib.PDFName.of('ObjStm') || type === pdfLib.PDFName.of('XRef');
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('compress requires CompressionStream, unavailable in this runtime');
  }
  // `deflate` is the zlib-wrapped format PDF's /FlateDecode expects;
  // `deflate-raw` would produce a stream no reader accepts.
  const compressed = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

function inflateStream(pdfLib: PdfLib, stream: PDFRawStream): boolean {
  const filter = stream.dict.lookup(pdfLib.PDFName.of('Filter'));
  if (!filter) return false;
  let decoded: Uint8Array;
  try {
    decoded = pdfLib.decodePDFRawStream(stream).decode();
  } catch {
    // Image codecs (DCTDecode, JPXDecode, CCITTFaxDecode, ...) have no plain
    // form. Real pdftk leaves them compressed too rather than failing the run.
    return false;
  }
  stream.updateContents(decoded);
  stream.dict.delete(pdfLib.PDFName.of('Filter'));
  stream.dict.delete(pdfLib.PDFName.of('DecodeParms'));
  return true;
}

async function deflateStream(pdfLib: PdfLib, stream: PDFRawStream): Promise<boolean> {
  if (stream.dict.lookup(pdfLib.PDFName.of('Filter'))) return false;
  stream.updateContents(await deflate(stream.getContents()));
  stream.dict.set(pdfLib.PDFName.of('Filter'), pdfLib.PDFName.of('FlateDecode'));
  return true;
}

/**
 * Rewrite every eligible stream in `doc` in place. Returns the number of
 * streams changed, so a caller can tell "nothing needed doing" from "the
 * document was already in that shape".
 */
export async function applyPdfStreamMode(
  pdfLib: PdfLib,
  doc: PDFDocument,
  mode: PdfStreamMode
): Promise<number> {
  if (doc.isEncrypted) {
    throw new Error(`cannot ${mode} an encrypted PDF`);
  }

  let changed = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof pdfLib.PDFRawStream)) continue;
    if (isStructuralStream(pdfLib, object.dict)) continue;
    const didChange =
      mode === 'uncompress' ? inflateStream(pdfLib, object) : await deflateStream(pdfLib, object);
    if (didChange) changed++;
  }
  return changed;
}

/**
 * Save options matching `mode`. `uncompress` also has to defeat pdf-lib's
 * default object streams — inflating the page contents is pointless if the
 * page dictionaries themselves come back out packed into an /ObjStm.
 */
export function saveOptionsFor(mode: PdfStreamMode | undefined): { useObjectStreams: boolean } {
  return { useObjectStreams: mode !== 'uncompress' };
}
