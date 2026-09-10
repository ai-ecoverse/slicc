/**
 * `gelatiere` — registration only. The body (`./gelatiere/run.ts`) carries
 * the help text and lazy-loads the store module with the bundled
 * `GELATIERE.md`; neither belongs in the worker's eager first-load bundle,
 * and a command that runs a few times a day does not need to be there.
 */

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
