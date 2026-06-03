import type { SlashCommand } from '../slash-commands.js';

export function createClearCommand(): SlashCommand {
  return {
    kind: 'action',
    name: 'clear',
    description: 'Clear the cone chat (no freeze).',
    async run(ctx) {
      if (!ctx.isCone()) {
        ctx.chat.addSystemMessage('`/clear` only works on the cone. Switch to the cone to use it.');
        return;
      }
      await ctx.actions.clearChat();
    },
  };
}
