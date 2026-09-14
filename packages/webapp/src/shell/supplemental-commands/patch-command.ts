import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createPatchCommand(): Command {
  return defineCommand('patch', async (args, ctx) => {
    const { runPatch } = await import('./patch/run.js');
    return runPatch(args, ctx);
  });
}
