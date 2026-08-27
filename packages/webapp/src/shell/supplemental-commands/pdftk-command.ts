/**
 * `pdftk` / `pdf` registration stub.
 *
 * The operations, the pdftk argument grammar, and the pdf-lib work live in
 * `pdftk/run.ts` and are imported on FIRST USE, not at registration:
 * `index.ts` is in the kernel worker's boot-critical graph, and a PDF
 * command nobody has typed yet has no business being downloaded before the
 * terminal opens (see `packages/webapp/first-load-budget.json`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createPdftkCommand(name: string = 'pdftk'): Command {
  return defineCommand(name, async (args, ctx) => {
    const { runPdftk } = await import('./pdftk/run.js');
    return runPdftk(name, args, ctx);
  });
}
