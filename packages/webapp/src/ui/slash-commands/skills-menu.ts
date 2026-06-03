import type { SlashCommand } from '../slash-commands.js';

/** The `/skills` entry. A submenu: selecting it drills into the installed
 *  skills list rather than firing an action or inserting text directly. */
export function createSkillsMenuCommand(): SlashCommand {
  return {
    kind: 'submenu',
    name: 'skills',
    description: 'Reference an installed skill',
  };
}
