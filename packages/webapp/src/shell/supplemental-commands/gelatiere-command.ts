import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';

export interface GelatiereCommandOptions {
  fs: VirtualFS;
}

export function createGelatiereCommand(options: GelatiereCommandOptions): Command {
  return defineCommand('gelatiere', async (args, ctx) => {
    const { runGelatiere } = await import('./gelatiere/run.js');
    return runGelatiere(args, ctx, options);
  });
}
