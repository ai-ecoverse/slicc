import type { VirtualFS } from '../../fs/virtual-fs.js';
import type { SlashCommand, SlashCommandRegistry } from '../slash-commands.js';
import { createSlashCommandRegistry } from '../slash-commands.js';
import { createClearCommand } from './clear.js';
import { listInstalledSkills } from './data-sources.js';
import { createFreezeCommand } from './freeze.js';
import { createHelpCommand } from './help.js';
import { createMemoryCommand } from './memory.js';
import { createNewCommand } from './new.js';
import { createSessionsCommand } from './sessions.js';
import { createSettingsCommand } from './settings.js';
import { createSkillReference } from './skill-reference.js';
import { createSkillsMenuCommand } from './skills-menu.js';

export async function buildSlashCommandRegistry(opts: {
  vfs: VirtualFS;
  /** Include `/sessions`. False in the extension, where the frozen-sessions
   *  rail is hidden and there's no surface for them. Defaults to true. */
  includeSessions?: boolean;
}): Promise<SlashCommandRegistry> {
  const actions: SlashCommand[] = [
    createHelpCommand(),
    createSettingsCommand(),
    createMemoryCommand(),
    ...(opts.includeSessions === false ? [] : [createSessionsCommand()]),
    createNewCommand(),
    createFreezeCommand(),
    createClearCommand(),
  ];
  const actionNames = new Set([...actions.map((c) => c.name), 'skills']);
  const skills = await listInstalledSkills(opts.vfs);
  const skillRefs = skills
    .filter((name) => !actionNames.has(name)) // action commands win on name collision
    .map((name) => createSkillReference(name));
  return createSlashCommandRegistry([...actions, createSkillsMenuCommand(), ...skillRefs]);
}
