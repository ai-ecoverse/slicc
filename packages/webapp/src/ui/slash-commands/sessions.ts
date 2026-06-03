import type { SlashCommand } from '../slash-commands.js';

export function createSessionsCommand(): SlashCommand {
  return {
    kind: 'action',
    name: 'sessions',
    description: 'Open frozen sessions list.',
    async run(ctx) {
      await ctx.actions.openFrozenSessions();
    },
  };
}
