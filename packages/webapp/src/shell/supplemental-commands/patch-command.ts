/**
 * `patch` registration stub.
 *
 * The unified-diff grammar and the hunk applier live in `git/patch-core.ts`
 * and the CLI in `patch/run.ts`, both imported on FIRST USE — `index.ts` sits
 * in the kernel worker's boot-critical graph (see
 * `packages/webapp/first-load-budget.json`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createPatchCommand(): Command {
  return defineCommand('patch', async (args, ctx) => {
    const { runPatch } = await import('./patch/run.js');
    return runPatch(args, ctx);
  });
}
