import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createSliccCommand(): Command {
  return defineCommand('slicc', async (args, ctx) => {
    const { runSlicc } = await import('./slicc/run.js');
    return await runSlicc(args, ctx);
  });
}
