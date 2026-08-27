/**
 * `pdftotext` registration stub.
 *
 * The poppler flag grammar and the pdf.js text extraction live in
 * `pdftotext/run.ts` and are imported on FIRST USE, not at registration —
 * `index.ts` sits in the kernel worker's boot-critical graph (see
 * `packages/webapp/first-load-budget.json`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createPdftotextCommand(name: string = 'pdftotext'): Command {
  return defineCommand(name, async (args, ctx) => {
    const { runPdftotext } = await import('./pdftotext/run.js');
    return runPdftotext(name, args, ctx);
  });
}
