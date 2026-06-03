import type { SlashCommand } from '../slash-commands.js';

export function createFreezeCommand(): SlashCommand {
  return {
    kind: 'action',
    name: 'freeze',
    description: 'Archive current session without clearing.',
    async run(ctx) {
      await ctx.actions.freezeSession();
    },
  };
}
