/**
 * `memory` — registration only. The body (`./memory/run.ts`) carries the
 * help text and the index/ledger readers; a command that inspects durable
 * memory a few times a session does not belong in the worker's eager
 * first-load bundle.
 */

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
