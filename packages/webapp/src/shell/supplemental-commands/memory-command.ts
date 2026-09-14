import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';

export interface MemoryCommandOptions {
  fs: VirtualFS;
}

export function createMemoryCommand(options: MemoryCommandOptions): Command {
  return defineCommand('memory', async (args) => {
    const { runMemory } = await import('./memory/run.js');
    return runMemory(args, options);
  });
}
