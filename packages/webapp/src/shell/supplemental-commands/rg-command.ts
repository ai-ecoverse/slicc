/**
 * Registration stub for the `rg` overlay (#3106).
 *
 * Behaviour lives in `rg/run.ts`, imported on FIRST USE: `index.ts` sits in
 * the kernel worker's boot-critical graph (`first-load-budget.json`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createRgCommand(): Command {
  return defineCommand('rg', async (args, ctx) => {
    const { runRg } = await import('./rg/run.js');
    return runRg(args, ctx);
  });
}
