import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createRgCommand(): Command {
  return defineCommand('rg', async (args, ctx) => {
    const { runRg } = await import('./rg/run.js');
    return runRg(args, ctx);
  });
}
