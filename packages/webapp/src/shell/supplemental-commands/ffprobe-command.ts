import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createFfprobeCommand(): Command {
  return defineCommand('ffprobe', async (args, ctx) => {
    const { runFfprobe } = await import('./ffprobe/run.js');
    return runFfprobe(args, ctx);
  });
}
