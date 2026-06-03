import type { SlashCommand } from '../slash-commands.js';

export function createNewCommand(): SlashCommand {
  return {
    kind: 'action',
    name: 'new',
    description: 'Freeze current session and start a new one.',
    async run(ctx) {
      await ctx.actions.newSession();
    },
  };
}
