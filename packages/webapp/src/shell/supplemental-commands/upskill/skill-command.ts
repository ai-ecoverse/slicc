/**
 * upskill — `skill` command (local operations alias).
 *
 * Extracted verbatim from `upskill-command.ts`. `skill` is a local-only alias
 * for `upskill` exposing `list`/`info`/`read`; installs from registries or
 * GitHub stay on the `upskill` command. No network I/O.
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../../fs/index.js';
import { formatDiscoveredSkills, formatDiscoveryScope, formatSkillInfo } from './help.js';

/**
 * Create skill command as an alias for upskill with local operations only.
 */
export function createSkillCommand(fs: VirtualFS): Command {
  return defineCommand('skill', async (args, _ctx: CommandContext) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return {
        stdout: `usage: skill <command> [options]

Commands:
  list                   List discoverable skills
  info <name>            Show details about a skill
  read <name>            Read the SKILL.md instructions

${formatDiscoveryScope()}
For installing skills from registries or GitHub, use 'upskill':
  upskill search "query"           Search registries (Tessl + browse.sh)
  upskill owner/repo --list        List skills in GitHub repo
  upskill owner/repo --all         Install from GitHub
  upskill tessl:<name>             Install from Tessl registry
  upskill browse:<host>/<task>     Install from browse.sh catalog

Examples:
  skill list
  skill info bluebubbles
  skill read bluebubbles
`,
        stderr: '',
        exitCode: 0,
      };
    }

    const subcommand = args[0];
    const skills = await import('../../../skills/index.js');

    try {
      switch (subcommand) {
        case 'list': {
          const discovered = await skills.discoverSkills(fs);

          if (discovered.length === 0) {
            return {
              stdout: `No discoverable skills found.\n\n${formatDiscoveryScope()}Install skills with: upskill owner/repo --all\n`,
              stderr: '',
              exitCode: 0,
            };
          }

          return {
            stdout: formatDiscoveredSkills(discovered, 'Discoverable skills'),
            stderr: '',
            exitCode: 0,
          };
        }

        case 'info': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'skill: info requires a skill name\n', exitCode: 1 };
          }

          const skill = await skills.getSkillInfo(fs, name);
          if (!skill) {
            return { stdout: '', stderr: `skill: "${name}" not found\n`, exitCode: 1 };
          }

          return { stdout: formatSkillInfo(skill), stderr: '', exitCode: 0 };
        }

        case 'read': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'skill: read requires a skill name\n', exitCode: 1 };
          }

          const instructions = await skills.readSkillInstructions(fs, name);
          if (instructions === null) {
            return { stdout: '', stderr: `skill: no SKILL.md found for "${name}"\n`, exitCode: 1 };
          }

          return { stdout: instructions + '\n', stderr: '', exitCode: 0 };
        }

        default:
          return { stdout: '', stderr: `skill: unknown command "${subcommand}"\n`, exitCode: 1 };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `skill: ${msg}\n`, exitCode: 1 };
    }
  });
}
