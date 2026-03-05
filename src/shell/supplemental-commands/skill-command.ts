import { defineCommand } from 'just-bash';
import type { Command, CommandContext } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';

function skillHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: skill <command> [options]

Commands:
  list                   List available and installed skills
  info <name>            Show details about a skill
  install <name>         Install a skill
  uninstall <name>       Uninstall a skill
  read <name>            Read the SKILL.md instructions

Examples:
  skill list
  skill info bluebubbles
  skill install bluebubbles
  skill uninstall bluebubbles
  skill read bluebubbles
`,
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Create the skill command with access to the virtual filesystem.
 */
export function createSkillCommand(fs: VirtualFS): Command {
  return defineCommand('skill', async (args, _ctx: CommandContext) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return skillHelp();
    }

    const subcommand = args[0];

    // Dynamically import skills module to avoid circular dependencies
    const skills = await import('../../skills/index.js');

    try {
      switch (subcommand) {
        case 'list': {
          const discovered = await skills.discoverSkills(fs);

          if (discovered.length === 0) {
            return {
              stdout: 'No skills found in /skills/\n\nCreate a skill by adding a directory with a manifest.yaml or SKILL.md\n',
              stderr: '',
              exitCode: 0,
            };
          }

          let output = 'Available skills:\n\n';
          output += '  NAME                 VERSION    STATUS\n';
          output += '  ────────────────────────────────────────\n';

          for (const skill of discovered) {
            const status = skill.installed
              ? `installed (v${skill.installedVersion})`
              : 'available';
            output += `  ${skill.name.padEnd(20)} ${skill.manifest.version.padEnd(10)} ${status}\n`;
          }

          return {
            stdout: output,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'info': {
          const name = args[1];
          if (!name) {
            return {
              stdout: '',
              stderr: 'skill: info requires a skill name\n',
              exitCode: 1,
            };
          }

          const skill = await skills.getSkillInfo(fs, name);
          if (!skill) {
            return {
              stdout: '',
              stderr: `skill: "${name}" not found\n`,
              exitCode: 1,
            };
          }

          let output = `Skill: ${skill.manifest.skill}\n`;
          output += `Version: ${skill.manifest.version}\n`;
          output += `Description: ${skill.manifest.description || '(none)'}\n`;
          output += `Status: ${skill.installed ? `installed (v${skill.installedVersion})` : 'not installed'}\n`;

          if (skill.manifest.adds?.length) {
            output += `\nAdds files:\n`;
            for (const f of skill.manifest.adds) {
              output += `  - ${f}\n`;
            }
          }

          if (skill.manifest.modifies?.length) {
            output += `\nModifies files:\n`;
            for (const f of skill.manifest.modifies) {
              output += `  - ${f}\n`;
            }
          }

          if (skill.manifest.depends?.length) {
            output += `\nDepends on: ${skill.manifest.depends.join(', ')}\n`;
          }

          if (skill.manifest.conflicts?.length) {
            output += `\nConflicts with: ${skill.manifest.conflicts.join(', ')}\n`;
          }

          return {
            stdout: output,
            stderr: '',
            exitCode: 0,
          };
        }

        case 'install': {
          const name = args[1];
          if (!name) {
            return {
              stdout: '',
              stderr: 'skill: install requires a skill name\n',
              exitCode: 1,
            };
          }

          const result = await skills.applySkill(fs, name);

          if (result.success) {
            return {
              stdout: `Successfully installed skill "${result.skill}" v${result.version}\n`,
              stderr: '',
              exitCode: 0,
            };
          } else {
            return {
              stdout: '',
              stderr: `skill: failed to install "${name}": ${result.error}\n`,
              exitCode: 1,
            };
          }
        }

        case 'uninstall': {
          const name = args[1];
          if (!name) {
            return {
              stdout: '',
              stderr: 'skill: uninstall requires a skill name\n',
              exitCode: 1,
            };
          }

          const result = await skills.uninstallSkill(fs, name);

          if (result.success) {
            return {
              stdout: `Successfully uninstalled skill "${result.skill}"\n`,
              stderr: '',
              exitCode: 0,
            };
          } else {
            return {
              stdout: '',
              stderr: `skill: failed to uninstall "${name}": ${result.error}\n`,
              exitCode: 1,
            };
          }
        }

        case 'read': {
          const name = args[1];
          if (!name) {
            return {
              stdout: '',
              stderr: 'skill: read requires a skill name\n',
              exitCode: 1,
            };
          }

          const instructions = await skills.readSkillInstructions(fs, name);

          if (instructions === null) {
            return {
              stdout: '',
              stderr: `skill: no SKILL.md found for "${name}"\n`,
              exitCode: 1,
            };
          }

          return {
            stdout: instructions + '\n',
            stderr: '',
            exitCode: 0,
          };
        }

        default:
          return {
            stdout: '',
            stderr: `skill: unknown command "${subcommand}"\n`,
            exitCode: 1,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        stdout: '',
        stderr: `skill: ${msg}\n`,
        exitCode: 1,
      };
    }
  });
}
