import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createPdftkCommand(name: string = 'pdftk'): Command {
  return defineCommand(name, async (args, ctx) => {
    const { runPdftk } = await import('./pdftk/run.js');
    return runPdftk(name, args, ctx);
  });
}
