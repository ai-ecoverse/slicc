/**
 * `cua-s1` — form decisions from the cua-s1-forms model.
 *
 * The body lives in `decision/cua-run.ts` and loads on the first invocation,
 * so the worker's first-load graph stays free of the snapshot parser.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { CuaS1CommandOptions } from './decision/cua-run.js';

export type { CuaS1CommandOptions } from './decision/cua-run.js';

export function createCuaS1Command(options: CuaS1CommandOptions = {}): Command {
  return defineCommand('cua-s1', async (args, ctx) => {
    const { createCuaS1Command: create } = await import('./decision/cua-run.js');
    const command = create(options);
    return command.execute(args, ctx);
  });
}
