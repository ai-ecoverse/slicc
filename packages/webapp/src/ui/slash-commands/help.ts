import type { SlashCommand } from '../slash-commands.js';

export function createHelpCommand(): SlashCommand {
  return {
    kind: 'action',
    name: 'help',
    description: 'Show the slash command list.',
    async run(ctx) {
      const all = ctx.getRegistry().list();
      const visible = all.filter((c) => c.kind !== 'skill');
      const lines = visible.map((c) => `- \`/${c.name}\` — ${c.description}`);
      const skillCount = all.filter((c) => c.kind === 'skill').length;
      if (skillCount > 0) {
        lines.push(
          `- _Plus ${skillCount} installed skill${skillCount === 1 ? '' : 's'} — type \`/skills\`._`
        );
      }
      ctx.chat.addSystemMessage(`**Slash commands**\n\n${lines.join('\n')}`);
    },
  };
}
