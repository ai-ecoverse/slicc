import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export interface BiscottoCommandOptions {
  getParentJid?: () => string | undefined;

  isScoop?: () => boolean;
}

export function createBiscottoCommand(
  name: string = 'biscotto',
  options: BiscottoCommandOptions = {}
): Command {
  return defineCommand(name, async (args, ctx) => {
    const { runBiscotto } = await import('./biscotto/run.js');
    return runBiscotto(name, args, ctx, options.getParentJid?.(), options.isScoop?.() === true);
  });
}
