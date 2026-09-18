import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createScreencaptureCommand(): Command {
  return defineCommand('screencapture', async (args, ctx) => {
    const { runScreencapture } = await import('./screencapture-run.js');
    return runScreencapture(args, ctx);
  });
}
