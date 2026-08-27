import type { IFileSystem, ResolvedCommandContext } from 'just-bash';
import { mockCommandContext } from './mock-command-context.js';

/**
 * A hand-written two-page PDF ("PAGE ONE" / "PAGE TWO", 200x100 pt, Helvetica,
 * uncompressed content streams). Small enough to inline as base64 — the same
 * document the `pdf-rasterize` e2e fixture uses — so the PDF commands can be
 * exercised against real pdf.js / pdf-lib instead of a mock that would hide
 * every encoding detail those libraries actually enforce.
 */
const TINY_PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA0IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMTAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNiAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMTAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNyAwIFIgPj4KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago2IDAgb2JqCjw8IC9MZW5ndGggNjYgPj4Kc3RyZWFtCjEgMCAwIHJnIDEwIDEwIDgwIDgwIHJlIGYKQlQgL0YxIDE0IFRmIDEwMCA0NSBUZCAoUEFHRSBPTkUpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNyAwIG9iago8PCAvTGVuZ3RoIDY2ID4+CnN0cmVhbQowIDAgMSByZyAxMCAxMCA4MCA4MCByZSBmCkJUIC9GMSAxNCBUZiAxMDAgNDUgVGQgKFBBR0UgVFdPKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDI0NyAwMDAwMCBuIAowMDAwMDAwMzczIDAwMDAwIG4gCjAwMDAwMDA0NDMgMDAwMDAgbiAKMDAwMDAwMDU1OCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDggL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjY3MwolJUVPRgo=';

export function tinyPdfBytes(): Uint8Array {
  return Uint8Array.from(atob(TINY_PDF_BASE64), (char) => char.charCodeAt(0));
}

export interface PdfHarness {
  /** In-memory VFS stand-in, keyed by absolute path. */
  files: Map<string, Uint8Array | string>;
  ctx: ResolvedCommandContext;
  /** Latin1 view of a written file, for `%PDF`-level assertions. */
  read(path: string): string;
}

/** Command context backed by a map, seeded with `/home/doc.pdf`. */
export function pdfHarness(initial: Record<string, Uint8Array | string> = {}): PdfHarness {
  const files = new Map<string, Uint8Array | string>(
    Object.entries({ '/home/doc.pdf': tinyPdfBytes(), ...initial })
  );
  const fs: Partial<IFileSystem> = {
    readFileBuffer: async (path: string) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`file not found: ${path}`);
      return typeof file === 'string' ? new TextEncoder().encode(file) : file;
    },
    writeFile: async (path: string, data: Uint8Array | string) => {
      files.set(path, data);
    },
  };
  return {
    files,
    ctx: mockCommandContext({ fs }),
    read(path: string) {
      const file = files.get(path);
      if (file === undefined) throw new Error(`not written: ${path}`);
      return typeof file === 'string' ? file : new TextDecoder('latin1').decode(file);
    },
  };
}
