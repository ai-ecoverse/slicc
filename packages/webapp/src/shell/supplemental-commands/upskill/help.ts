/**
 * upskill — help text and skill-listing formatters.
 *
 * Extracted verbatim from `upskill-command.ts`. These functions are pure
 * string builders with no fetch or filesystem dependencies.
 */

import type { DiscoveredSkill } from '../../../skills/types.js';

export function formatDiscoveryScope(): string {
  return 'Discovery roots: /workspace/skills plus accessible **/.agents/skills/*, **/.claude/skills/*, **/.claude-plugin/marketplace.json skill collections anywhere in the VFS, and installed agent plugins (`plugin list`).\n';
}

export function formatSkillSource(source: DiscoveredSkill['source']): string {
  switch (source) {
    case 'native':
      return 'native';
    case 'agents':
      return '.agents';
    case 'claude':
      return '.claude';
    case 'marketplace':
      return 'marketplace';
    case 'plugin':
      return 'plugin';
  }
}

export function formatDiscoveredSkills(discovered: DiscoveredSkill[], heading: string): string {
  const nameWidth = Math.max(4, ...discovered.map((s) => s.name.length));
  const sourceWidth = 11; // 'marketplace'.length
  // 2 indent + nameWidth + 2 sep + sourceWidth + 1 sep = fixed overhead
  const descWidth = Math.max(20, 99 - 2 - nameWidth - 2 - sourceWidth - 1);

  const header = 'NAME'.padEnd(nameWidth);
  const divider = '─'.repeat(2 + nameWidth + 2 + sourceWidth + 1 + descWidth);

  let output = `${heading}:\n\n`;
  output += `  ${header}  SOURCE      DESCRIPTION\n`;
  output += `${divider}\n`;

  for (const skill of discovered) {
    const raw = skill.description || '';
    const description = raw.length > descWidth ? `${raw.slice(0, descWidth - 1)}…` : raw;
    output += `  ${skill.name.padEnd(nameWidth)}  ${formatSkillSource(skill.source).padEnd(sourceWidth)} ${description}\n`;
  }

  output += `\n${formatDiscoveryScope()}`;
  return output;
}

export function formatSkillInfo(skill: DiscoveredSkill): string {
  let output = `Skill: ${skill.name}\n`;
  output += `Description: ${skill.description || '(none)'}\n`;
  output += `Source: ${formatSkillSource(skill.source)}\n`;
  output += `Source root: ${skill.sourceRoot}\n`;

  if (skill.skillFilePath) {
    output += `Instructions: ${skill.skillFilePath}\n`;
  }

  if (skill.shadowedPaths?.length) {
    output += 'Shadowed paths:\n';
    for (const path of skill.shadowedPaths) {
      output += `  - ${path}\n`;
    }
  }

  return output;
}

export function upskillHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: upskill <command> [options]

Install skills from GitHub repositories, the Tessl registry, or browse.sh.

Commands:
  search <query>             Search registries for skills
  list                       List discoverable local skills
  tabs [--json]              Suggest skills for open browser tabs
  info <name>                Show details about a discoverable local skill
  read <name>                Read the SKILL.md instructions
  update [<skill>…]          Refresh installed skills from recorded provenance
  upgrade [<skill>…]         Alias of update
  outdated                   List installed skills behind their recorded source
  <owner/repo>               Install skill(s) from GitHub repository
  tessl:<name>               Install skill from Tessl registry
  browse:<hostname>/<task>   Install site-specific skill from browse.sh

${formatDiscoveryScope()}
GitHub Installation:
  upskill owner/repo                     List available skills in repo
  upskill owner/repo --skill name        Install specific skill
  upskill owner/repo --all               Install all skills from repo
  upskill owner/repo --path subdir       Restrict to subfolder
  upskill owner/repo@branch              Install from a specific branch
  upskill owner/repo --branch name       Same, using flag syntax

Updating installed skills:
  upskill update                         Update every skill with recorded provenance
  upskill update <skill>                 Update just that skill
  upskill update --dry-run               Report what would change; write nothing
  upskill update <skill> --branch <ref>  Update from a different ref
  upskill update <skill> --from o/r      Record provenance for a pre-provenance skill
  upskill outdated                       List skills whose recorded sha is behind

  Every install records \`<skill>/.upskill\` — source kind, owner/repo, ref,
  resolved commit sha, timestamp. Updates classify each path as unchanged /
  updated / added / removed / kept-local, and report "already current" when the
  recorded sha still matches the tip of the tracked ref.

  Dotfiles are protected: upskill never overwrites and never deletes a dotfile
  that already exists in a skill directory (this is what preserves
  \`scripts/.config\` credentials and the \`.upskill\` record). A dotfile that is
  absent locally is still installed, so skills that ship \`.gitignore\` upstream
  work as before.

Recommendations:
  upskill recommendations                Show skills matching your profile
  upskill recommendations --install      Install all recommended skills

Registry Search:
  upskill search "pdf conversion"        Search registries
  upskill tessl:postgres-pro             Install from Tessl (via GitHub)
  upskill browse:weather.gov/get-forecast-1uezib
                                         Install from browse.sh by slug
  upskill https://browse.sh/skills/weather.gov/get-forecast-1uezib
                                         Same, using the URL form

Options:
  --skill <name>           Install specific skill (repeatable)
  --all                    Install all skills from source
  --path <subfolder>       Only discover skills under this subfolder
  --branch, -b <name>      Install from a specific branch (default: main)
  --list                   List available skills without installing
  --force                  Overwrite existing skills (dotfiles are preserved)
  --dry-run, -n            update/upgrade only: report changes, write nothing
  --from <owner>/<repo>    update only: source for a skill with no .upskill
  -h, --help               Show help

GitHub rate limits:
  On shared VPNs or corporate IPs, anonymous GitHub access may be rate-limited.
  Configure a token to avoid shared-IP limits: git config github.token <PAT>

Examples:
  upskill search "browser automation"
  upskill anthropics/skills --list
  upskill anthropics/skills --skill pdf --skill xlsx
  upskill adobe/skills --path skills/aem --all
  upskill aemcoder/skills@fix/stateless-tab-targeting --all
  upskill tessl:postgres-pro
  upskill browse:weather.gov/get-forecast-1uezib
`,
    stderr: '',
    exitCode: 0,
  };
}
