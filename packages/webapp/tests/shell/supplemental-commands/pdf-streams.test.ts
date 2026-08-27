import * as pdfLib from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  applyPdfStreamMode,
  saveOptionsFor,
} from '../../../src/shell/supplemental-commands/pdf-streams.js';
import { createPdftkCommand } from '../../../src/shell/supplemental-commands/pdftk-command.js';
import { pdfHarness, tinyPdfBytes } from '../helpers/pdf-fixtures.js';

describe('saveOptionsFor', () => {
  it('turns object streams off for uncompress so the xref stays greppable', () => {
    expect(saveOptionsFor('uncompress')).toEqual({ useObjectStreams: false });
  });

  it('leaves the pdf-lib default in place otherwise', () => {
    expect(saveOptionsFor('compress')).toEqual({ useObjectStreams: true });
    expect(saveOptionsFor(undefined)).toEqual({ useObjectStreams: true });
  });
});

describe('applyPdfStreamMode', () => {
  it('deflates then inflates the same streams, reporting how many changed', async () => {
    const doc = await pdfLib.PDFDocument.load(tinyPdfBytes());
    expect(await applyPdfStreamMode(pdfLib, doc, 'compress')).toBe(2);
    // Already deflated: nothing left to do on a second pass.
    expect(await applyPdfStreamMode(pdfLib, doc, 'compress')).toBe(0);
    expect(await applyPdfStreamMode(pdfLib, doc, 'uncompress')).toBe(2);
    expect(await applyPdfStreamMode(pdfLib, doc, 'uncompress')).toBe(0);
  });

  it('leaves a stream whose codec has no plain form alone', async () => {
    const doc = await pdfLib.PDFDocument.load(tinyPdfBytes());
    const jpeg = pdfLib.PDFRawStream.of(
      doc.context.obj({ Subtype: 'Image', Filter: 'DCTDecode' }) as pdfLib.PDFDict,
      new Uint8Array([0xff, 0xd8, 0xff])
    );
    doc.context.register(jpeg);

    await applyPdfStreamMode(pdfLib, doc, 'uncompress');
    expect(jpeg.getContents()).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(jpeg.dict.lookup(pdfLib.PDFName.of('Filter'))).toBe(pdfLib.PDFName.of('DCTDecode'));
  });

  it('refuses to rewrite an encrypted document', async () => {
    const doc = { isEncrypted: true } as unknown as pdfLib.PDFDocument;
    await expect(applyPdfStreamMode(pdfLib, doc, 'uncompress')).rejects.toThrow(
      'cannot uncompress an encrypted PDF'
    );
  });
});

describe('pdftk output options (real pdf-lib)', () => {
  it('uncompress writes a PDF whose page operators are readable', async () => {
    const harness = pdfHarness();
    const result = await createPdftkCommand().execute(
      ['doc.pdf', 'output', 'out.pdf', 'uncompress'],
      harness.ctx
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const out = harness.read('/home/out.pdf');
    expect(out.startsWith('%PDF-')).toBe(true);
    expect(out).toContain('PAGE ONE');
    expect(out).not.toContain('/ObjStm');
  });

  it('accepts uncompress before the output keyword too', async () => {
    const harness = pdfHarness();
    const result = await createPdftkCommand().execute(
      ['doc.pdf', 'uncompress', 'output', 'out.pdf'],
      harness.ctx
    );
    expect(result.exitCode).toBe(0);
    expect(harness.read('/home/out.pdf')).toContain('PAGE ONE');
  });

  it('compress deflates the streams, and uncompress brings the text back', async () => {
    const harness = pdfHarness();
    expect(
      (await createPdftkCommand().execute(['doc.pdf', 'output', 'c.pdf', 'compress'], harness.ctx))
        .exitCode
    ).toBe(0);
    const compressed = harness.read('/home/c.pdf');
    expect(compressed).toContain('/FlateDecode');
    expect(compressed).not.toContain('PAGE ONE');

    harness.files.set('/home/round.pdf', harness.files.get('/home/c.pdf') as Uint8Array);
    await createPdftkCommand().execute(['round.pdf', 'output', 'u.pdf', 'uncompress'], harness.ctx);
    const restored = harness.read('/home/u.pdf');
    expect(restored).toContain('PAGE ONE');
    expect(restored).not.toContain('/FlateDecode');
  });

  it('streams the PDF to stdout as bytes for "output -"', async () => {
    const { ctx } = pdfHarness();
    const result = await createPdftkCommand().execute(['doc.pdf', 'output', '-'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdoutKind).toBe('bytes');
    expect(result.stdout.startsWith('%PDF-')).toBe(true);
  });
});
