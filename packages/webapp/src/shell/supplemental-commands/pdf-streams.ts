import type { PDFDict, PDFDocument, PDFRawStream } from '@cantoo/pdf-lib';

type PdfLib = typeof import('@cantoo/pdf-lib');

export type PdfStreamMode = 'uncompress' | 'compress';

function isStructuralStream(pdfLib: PdfLib, dict: PDFDict): boolean {
  const type = dict.lookup(pdfLib.PDFName.of('Type'));

  return type === pdfLib.PDFName.of('ObjStm') || type === pdfLib.PDFName.of('XRef');
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('compress requires CompressionStream, unavailable in this runtime');
  }

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

export function saveOptionsFor(mode: PdfStreamMode | undefined): { useObjectStreams: boolean } {
  return { useObjectStreams: mode !== 'uncompress' };
}
