import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createPdftotextCommand(name: string = 'pdftotext'): Command {
  return defineCommand(name, async (args, ctx) => {
    const { runPdftotext } = await import('./pdftotext/run.js');
    return runPdftotext(name, args, ctx);
  });
}
