/**
 * `ffmpeg` registration stub.
 *
 * The argv grammar, camera capture, WORKERFS staging and both engines
 * (mediabunny fast path + `@ffmpeg/core` wasm) live in `ffmpeg/run.ts`
 * and are imported on FIRST USE, not at registration — `index.ts` sits
 * in the kernel worker's boot-critical graph (see
 * `packages/webapp/first-load-budget.json`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createFfmpegCommand(): Command {
  return defineCommand('ffmpeg', async (args, ctx) => {
    const { runFfmpeg } = await import('./ffmpeg/run.js');
    return runFfmpeg(args, ctx);
  });
}
