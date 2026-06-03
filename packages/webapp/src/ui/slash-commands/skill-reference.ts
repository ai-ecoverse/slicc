import type { SlashCommand } from '../slash-commands.js';

/** A reference to an installed skill. Inserts `/<name>` as inline text in
 *  the composer (no run) — the agent reads the reference on send. */
export function createSkillReference(skillName: string): SlashCommand {
  return {
    kind: 'skill',
    name: skillName,
    description: `Reference the ${skillName} skill`,
  };
}
