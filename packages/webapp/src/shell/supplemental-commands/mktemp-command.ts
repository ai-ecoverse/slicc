import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createMktempCommand(): Command {
  return defineCommand('mktemp', async (args, ctx) => {
    const { runMktemp } = await import('./mktemp/run.js');
    return runMktemp(args, ctx);
  });
}
