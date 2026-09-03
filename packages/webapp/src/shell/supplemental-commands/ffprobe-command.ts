/**
 * `ffprobe` registration stub.
 *
 * The banner parser and wasm probe live in `ffprobe/run.ts` and are
 * imported on FIRST USE, not at registration — `index.ts` sits in the
 * kernel worker's boot-critical graph (see
 * `packages/webapp/first-load-budget.json`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createFfprobeCommand(): Command {
  return defineCommand('ffprobe', async (args, ctx) => {
    const { runFfprobe } = await import('./ffprobe/run.js');
    return runFfprobe(args, ctx);
  });
}
