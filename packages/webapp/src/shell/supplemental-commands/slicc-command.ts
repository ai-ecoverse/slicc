/**
 * `slicc` registration stub.
 *
 * The verb grammar, help text, and panel-RPC bridging live in `slicc/run.ts`
 * and are imported on FIRST USE, not at registration — `index.ts` sits in the
 * kernel worker's boot-critical graph (see
 * `packages/webapp/first-load-budget.json`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createSliccCommand(): Command {
  return defineCommand('slicc', async (args, ctx) => {
    const { runSlicc } = await import('./slicc/run.js');
    return await runSlicc(args, ctx);
  });
}
