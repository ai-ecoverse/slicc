/**
 * `convert` / `magick` registration stub.
 *
 * The ImageMagick argv grammar and `magick-wasm` glue live in
 * `convert/run.ts` and are imported on FIRST USE, not at registration —
 * `index.ts` sits in the kernel worker's boot-critical graph (see
 * `packages/webapp/first-load-budget.json`). Same pattern as
 * `ffmpeg-command.ts` / `pdftk-command.ts` / `screencapture-command.ts`.
 *
 * Inside `convert/run.ts` → `magick-wasm.ts`, `@imagemagick/magick-wasm`
 * stays a STATIC named import (NS1 / F-C04): a dynamic
 * `import('@imagemagick/magick-wasm')` becomes a `__vitePreload`-wrapped
 * chunk that never settles in the DedicatedWorker.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createConvertCommand(name: string = 'convert'): Command {
  return defineCommand(name, async (args, ctx) => {
    const { runConvert } = await import('./convert/run.js');
    return runConvert(name, args, ctx);
  });
}
