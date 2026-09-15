/**
 * `chmod` registration stub.
 *
 * Behaviour lives in `chmod/run.ts` and is imported on FIRST USE:
 * `index.ts` sits in the kernel worker's boot-critical graph
 * (`packages/webapp/first-load-budget.json`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createChmodCommand(): Command {
  return defineCommand('chmod', async (args, ctx) => {
    const { runChmod } = await import('./chmod/run.js');
    return runChmod(args, ctx);
  });
}
