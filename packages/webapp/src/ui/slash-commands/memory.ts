import type { SlashCommand } from '../slash-commands.js';

export function createMemoryCommand(): SlashCommand {
  return {
    kind: 'action',
    name: 'memory',
    description: 'Open the cone memory file.',
    async run(ctx) {
      await ctx.actions.openMemory();
    },
  };
}
