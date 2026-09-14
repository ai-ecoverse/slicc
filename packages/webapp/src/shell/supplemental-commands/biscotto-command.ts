import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createBiscottoCommand(name: string = 'biscotto'): Command {
  return defineCommand(name, async (args, ctx) => {
    const { runBiscotto } = await import('./biscotto/run.js');
    return runBiscotto(name, args, ctx);
  });
}
