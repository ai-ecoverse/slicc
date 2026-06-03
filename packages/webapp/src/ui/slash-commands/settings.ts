import type { SlashCommand } from '../slash-commands.js';

export function createSettingsCommand(): SlashCommand {
  return {
    kind: 'action',
    name: 'settings',
    description: 'Open the settings dialog.',
    async run(ctx) {
      await ctx.actions.openSettings();
    },
  };
}
