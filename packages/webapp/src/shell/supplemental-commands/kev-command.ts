/**
 * `kev` — typed decisions from a Kev model.
 *
 * The body lives in `decision/kev-run.ts` and loads on the first invocation.
 * A static import would pull the parsers into the worker's first-load graph.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { KevCommandOptions } from './decision/kev-run.js';

export type { KevCommandOptions } from './decision/kev-run.js';

export function createKevCommand(options: KevCommandOptions = {}): Command {
  return defineCommand('kev', async (args, ctx) => {
    const { createKevCommand: create } = await import('./decision/kev-run.js');
    const command = create(options);
    return command.execute(args, ctx);
  });
}
