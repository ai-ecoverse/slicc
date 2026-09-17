/**
 * `screencapture` — registration only. The body (`./screencapture-run.ts`)
 * carries help text, video flags, and MediaRecorder capture; those belong
 * behind a dynamic import so they stay out of the worker's eager first-load
 * graph (same pattern as `gelatiere-command.ts`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createScreencaptureCommand(): Command {
  return defineCommand('screencapture', async (args, ctx) => {
    const { runScreencapture } = await import('./screencapture-run.js');
    return runScreencapture(args, ctx);
  });
}
