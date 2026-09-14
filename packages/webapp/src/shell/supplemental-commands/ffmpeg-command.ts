import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createFfmpegCommand(): Command {
  return defineCommand('ffmpeg', async (args, ctx) => {
    const { runFfmpeg } = await import('./ffmpeg/run.js');
    return runFfmpeg(args, ctx);
  });
}
