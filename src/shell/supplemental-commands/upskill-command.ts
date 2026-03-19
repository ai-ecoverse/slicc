import { defineCommand } from 'just-bash';
import type { Command, CommandContext, SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import type { DiscoveredSkill } from '../../skills/types.js';
import { unzipSync } from 'fflate';
import { consumeCachedBinaryByUrl } from '../binary-cache.js';

// ClawHub uses a Convex backend - this is the actual API endpoint
const CLAWHUB_API = 'https://wry-manatee-359.convex.site/api/v1';
const SKILLS_DIR = '/workspace/skills';

interface ClawHubSearchResult {
  slug: string;
  displayName: string;
  summary: string;
  version: string | null;
  updatedAt: number;
  score?: number;
}

interface ClawHubSearchResponse {
  results: ClawHubSearchResult[];
}

interface GitHubContent {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url?: string;
}

function formatDiscoveryScope(): string {
  return 'Discovery roots: /workspace/skills plus accessible **/.agents/skills/* and **/.claude/skills/* anywhere in the VFS.\n';
}

function formatManagementScope(): string {
  return 'Only native /workspace/skills entries are install-managed; compatibility-discovered .agents/.claude skills remain read-only.\n';
}

function formatSkillSource(source: DiscoveredSkill['source']): string {
  switch (source) {
    case 'native':
      return 'native';
    case 'agents':
      return '.agents';
    case 'claude':
      return '.claude';
  }
}

function isInstallManagedSkill(skill: DiscoveredSkill): boolean {
  return skill.source === 'native';
}

function formatSkillStatus(skill: DiscoveredSkill): string {
  if (!isInstallManagedSkill(skill)) {
    if (skill.installed && skill.installedVersion) {
      return `compatibility (state v${skill.installedVersion})`;
    }
    return 'compatibility (read-only)';
  }

  if (skill.installed && skill.installedVersion) {
    return `installed (v${skill.installedVersion})`;
  }

  return 'available';
}

function formatManagementMode(skill: DiscoveredSkill): string {
  return isInstallManagedSkill(skill)
    ? 'install-managed (/workspace/skills)'
    : 'compatibility-only (read-only)';
}

function formatDiscoveredSkills(
  discovered: DiscoveredSkill[],
  heading: string,
): string {
  let output = `${heading}:\n\n`;
  output += '  NAME                 VERSION    SOURCE    STATUS\n';
  output += '  ─────────────────────────────────────────────────────────────\n';

  for (const skill of discovered) {
    output += `  ${skill.name.padEnd(20)} ${skill.manifest.version.padEnd(10)} ${formatSkillSource(skill.source).padEnd(9)} ${formatSkillStatus(skill)}\n`;
  }

  output += `\n${formatDiscoveryScope()}`;
  output += formatManagementScope();
  return output;
}

function formatSkillInfo(skill: DiscoveredSkill): string {
  let output = `Skill: ${skill.manifest.skill}\n`;
  output += `Version: ${skill.manifest.version}\n`;
  output += `Description: ${skill.manifest.description || '(none)'}\n`;
  output += `Source: ${formatSkillSource(skill.source)}\n`;
  output += `Source root: ${skill.sourceRoot}\n`;
  output += `Management: ${formatManagementMode(skill)}\n`;
  output += `Status: ${formatSkillStatus(skill)}\n`;

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

function formatCompatibilityMutationError(
  commandName: 'skill' | 'upskill',
  skill: DiscoveredSkill,
): string {
  return `${commandName}: "${skill.name}" is discoverable from ${skill.sourceRoot} but remains compatibility-only/read-only. Only native /workspace/skills entries are install-managed.\n`;
}

function upskillHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: upskill <command> [options]

Install skills from GitHub repositories or ClawHub registry.

Commands:
  search <query>           Search ClawHub for skills
  list                     List discoverable local skills
  info <name>              Show details about a discoverable local skill
  read <name>              Read the SKILL.md instructions
  <owner/repo>             Install skill(s) from GitHub repository
  <clawhub-url>            Install skill from ClawHub URL

${formatDiscoveryScope()}${formatManagementScope()}

GitHub Installation:
  upskill owner/repo                     List available skills in repo
  upskill owner/repo --skill name        Install specific skill
  upskill owner/repo --all               Install all skills from repo
  upskill owner/repo --path subdir       Restrict to subfolder

ClawHub Installation:
  upskill search "pdf conversion"        Search for skills
  upskill https://clawhub.ai/user/skill  Install from ClawHub URL
  upskill clawhub:user/skill             Install from ClawHub shorthand

Options:
  --skill <name>           Install specific skill (repeatable)
  --all                    Install all skills from source
  --path <subfolder>       Only discover skills under this subfolder
  --list                   List available skills without installing
  --force                  Overwrite existing skills
  -h, --help               Show help

Examples:
  upskill search "browser automation"
  upskill anthropics/skills --list
  upskill anthropics/skills --skill pdf --skill xlsx
  upskill adobe/skills --path skills/aem --all
  upskill https://clawhub.ai/arun-8687/tavily-search
`,
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Search ClawHub registry for skills
 */
async function searchClawHub(
  query: string,
  fetch: SecureFetch,
  _limit: number = 10
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const url = `${CLAWHUB_API}/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (response.status !== 200) {
      return {
        stdout: '',
        stderr: `upskill: ClawHub search failed (HTTP ${response.status})\n`,
        exitCode: 1,
      };
    }

    const data = JSON.parse(response.body) as ClawHubSearchResponse;

    if (!data.results || data.results.length === 0) {
      return {
        stdout: `No skills found for "${query}"\n\nTry a different search term or browse https://clawhub.ai\n`,
        stderr: '',
        exitCode: 0,
      };
    }

    let output = `Search results for "${query}" (${data.results.length} found):\n\n`;

    for (const skill of data.results) {
      output += `  ${skill.slug.padEnd(35)} ${(skill.displayName || skill.slug).padEnd(25)}\n`;
      if (skill.summary) {
        output += `    ${skill.summary.slice(0, 70)}${skill.summary.length > 70 ? '...' : ''}\n`;
      }
      output += '\n';
    }

    output += `\nTo install: upskill clawhub:<slug>\n`;
    output += `Example: upskill clawhub:${data.results[0]?.slug || 'skill-name'}\n`;

    return { stdout: output, stderr: '', exitCode: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `upskill: search failed: ${msg}\n`,
      exitCode: 1,
    };
  }
}

/**
 * Install a skill from ClawHub (downloads as ZIP)
 */
async function installFromClawHub(
  slug: string,
  fs: VirtualFS,
  fetch: SecureFetch,
  force: boolean = false
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    // Check if skill already exists
    const skillDir = `${SKILLS_DIR}/${slug}`;
    try {
      await fs.stat(skillDir);
      if (!force) {
        return {
          stdout: '',
          stderr: `upskill: skill "${slug}" already exists (use --force to overwrite)\n`,
          exitCode: 1,
        };
      }
      // Remove existing skill
      await fs.rm(skillDir, { recursive: true });
    } catch {
      // Skill doesn't exist, good to proceed
    }

    // Download skill ZIP bundle from ClawHub
    const downloadUrl = `${CLAWHUB_API}/download?slug=${encodeURIComponent(slug)}`;
    const downloadResponse = await fetch(downloadUrl, {});

    if (downloadResponse.status === 404) {
      return {
        stdout: '',
        stderr: `upskill: skill "${slug}" not found on ClawHub\n`,
        exitCode: 1,
      };
    }

    if (downloadResponse.status !== 200) {
      return {
        stdout: '',
        stderr: `upskill: failed to download skill (HTTP ${downloadResponse.status})\n`,
        exitCode: 1,
      };
    }

    // The response body should be latin1-encoded by the fetch proxy for binary content.
    // Try to get the raw binary from the cache first (bypasses string encoding issues).
    const contentType = downloadResponse.headers['content-type'] || '';
    
    // Try to get cached binary data by URL first (most reliable - bypasses string encoding issues)
    let zipBytes = consumeCachedBinaryByUrl(downloadUrl);
    let badCharIdx = -1;
    let badCharCode = 0;
    
    if (!zipBytes) {
      // Fallback: Convert latin1 string to bytes - each char code maps directly to a byte
      zipBytes = new Uint8Array(downloadResponse.body.length);
      for (let i = 0; i < downloadResponse.body.length; i++) {
        const code = downloadResponse.body.charCodeAt(i);
        if (code > 255 && badCharIdx < 0) {
          badCharIdx = i;
          badCharCode = code;
        }
        zipBytes[i] = code & 0xFF; // Mask to byte range
      }
    }

    // Unzip the bundle
    let files: ReturnType<typeof unzipSync>;
    try {
      files = unzipSync(zipBytes);
    } catch (unzipErr) {
      const msg = unzipErr instanceof Error ? unzipErr.message : String(unzipErr);
      // Debug info
      const hexPreview = Array.from(zipBytes.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      const badCharInfo = badCharIdx >= 0 ? `\nBad char at ${badCharIdx}: code ${badCharCode}` : '';
      return {
        stdout: '',
        stderr: `upskill: failed to unzip: ${msg}\nContent-Type: ${contentType}\nBody: ${downloadResponse.body.length} chars\nHex: ${hexPreview}${badCharInfo}\n`,
        exitCode: 1,
      };
    }

    // Create skill directory
    await fs.mkdir(skillDir, { recursive: true });

    // Extract files
    let fileCount = 0;
    for (const [entryPath, content] of Object.entries(files)) {
      const normalized = entryPath.replace(/\\/g, '/');
      if (!normalized || normalized.endsWith('/')) continue;

      // Skip _meta.json if present (ClawHub metadata)
      if (normalized === '_meta.json') continue;

      const filePath = `${skillDir}/${normalized}`;
      const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (parentDir !== skillDir) {
        await fs.mkdir(parentDir, { recursive: true });
      }

      // Write file content (Uint8Array)
      await fs.writeFile(filePath, content);
      fileCount++;
    }

    await refreshSprinklesAfterInstall();
    return {
      stdout: `Installed skill "${slug}" from ClawHub (${fileCount} files)\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `upskill: failed to install from ClawHub: ${msg}\n`,
      exitCode: 1,
    };
  }
}

/**
 * List skills in a GitHub repository
 */
async function listGitHubSkills(
  owner: string,
  repo: string,
  fetch: SecureFetch,
  subPath?: string
): Promise<{ skills: Array<{ name: string; path: string }>; error?: string }> {
  const skills: Array<{ name: string; path: string }> = [];

  async function scanDir(path: string): Promise<void> {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'slicc-upskill',
      },
    });

    if (response.status !== 200) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const contents = JSON.parse(response.body) as GitHubContent[];

    for (const item of contents) {
      if (item.type === 'file' && item.name === 'SKILL.md') {
        // Found a skill - use parent directory as skill name
        const skillPath = item.path.replace('/SKILL.md', '');
        const skillName = skillPath.split('/').pop() || skillPath;
        skills.push({ name: skillName, path: skillPath });
      } else if (item.type === 'dir') {
        // Recurse into directories
        await scanDir(item.path);
      }
    }
  }

  try {
    await scanDir(subPath || '');
    return { skills };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { skills: [], error: msg };
  }
}

/**
 * Install a skill from GitHub repository
 */
async function installFromGitHub(
  owner: string,
  repo: string,
  skillPath: string,
  skillName: string,
  fs: VirtualFS,
  fetch: SecureFetch,
  force: boolean = false
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    // Check if skill already exists
    const destDir = `${SKILLS_DIR}/${skillName}`;
    try {
      await fs.stat(destDir);
      if (!force) {
        return {
          stdout: '',
          stderr: `upskill: skill "${skillName}" already exists (use --force to overwrite)\n`,
          exitCode: 1,
        };
      }
      // Remove existing skill
      await fs.rm(destDir, { recursive: true });
    } catch {
      // Doesn't exist, continue
    }

    // Get directory contents
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${skillPath}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'slicc-upskill',
      },
    });

    if (response.status !== 200) {
      return {
        stdout: '',
        stderr: `upskill: failed to fetch skill from GitHub (HTTP ${response.status})\n`,
        exitCode: 1,
      };
    }

    const contents = JSON.parse(response.body) as GitHubContent[];

    // Create skill directory
    await fs.mkdir(destDir, { recursive: true });

    // Download each file
    async function downloadDir(items: GitHubContent[], destBase: string): Promise<void> {
      for (const item of items) {
        if (item.type === 'file' && item.download_url) {
          const fileResponse = await fetch(item.download_url, {});
          if (fileResponse.status === 200) {
            await fs.writeFile(`${destBase}/${item.name}`, fileResponse.body);
          }
        } else if (item.type === 'dir') {
          // Recursively download subdirectory
          const subUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}`;
          const subResponse = await fetch(subUrl, {
            headers: {
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'slicc-upskill',
            },
          });
          if (subResponse.status === 200) {
            const subContents = JSON.parse(subResponse.body) as GitHubContent[];
            await fs.mkdir(`${destBase}/${item.name}`, { recursive: true });
            await downloadDir(subContents, `${destBase}/${item.name}`);
          }
        }
      }
    }

    await downloadDir(contents, destDir);

    await refreshSprinklesAfterInstall();
    return {
      stdout: `Installed skill "${skillName}" from ${owner}/${repo}\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `upskill: failed to install from GitHub: ${msg}\n`,
      exitCode: 1,
    };
  }
}

/**
 * Parse ClawHub URL or shorthand into a slug.
 * ClawHub URLs are: https://clawhub.ai/{owner}/{slug}
 * But the API only needs the slug (e.g., "tavily-search")
 */
function parseClawHubRef(ref: string): string | null {
  // Handle full URL: https://clawhub.ai/user/skill-slug
  const urlMatch = ref.match(/^https?:\/\/clawhub\.ai\/[^\/]+\/([^\/]+)/);
  if (urlMatch) {
    return urlMatch[1]; // Return just the slug, not owner/slug
  }

  // Handle shorthand: clawhub:slug or clawhub:owner/slug
  if (ref.startsWith('clawhub:')) {
    const rest = ref.slice(8);
    // If it contains a slash, take the second part (the slug)
    if (rest.includes('/')) {
      return rest.split('/')[1];
    }
    // Otherwise it's just the slug
    return rest;
  }

  return null;
}

/**
 * Parse GitHub repo reference
 */
function parseGitHubRef(ref: string): { owner: string; repo: string } | null {
  // Handle owner/repo format
  const match = ref.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

/** After a successful install, refresh sprinkle manager and auto-open new sprinkles. */
async function refreshSprinklesAfterInstall(): Promise<void> {
  try {
    if (typeof window === 'undefined') return;
    const mgr = (window as unknown as Record<string, unknown>).__slicc_sprinkleManager;
    if (mgr && typeof (mgr as Record<string, unknown>).openNewAutoOpenSprinkles === 'function') {
      await (mgr as { openNewAutoOpenSprinkles: () => Promise<void> }).openNewAutoOpenSprinkles();
    }
  } catch { /* best-effort */ }
}

/**
 * Create the upskill command with access to the virtual filesystem.
 */
export function createUpskillCommand(fs: VirtualFS, fetchFn: SecureFetch): Command {
  return defineCommand('upskill', async (args, _ctx: CommandContext) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return upskillHelp();
    }

    // Parse arguments
    const selectedSkills: string[] = [];
    let subPath: string | undefined;
    let listOnly = false;
    let installAll = false;
    let force = false;
    let sourceRef = '';
    let searchQuery = '';

    let i = 0;
    while (i < args.length) {
      const arg = args[i];

      if (arg === 'search') {
        // Collect the search query
        searchQuery = args.slice(i + 1).join(' ');
        break;
      } else if (arg === 'list') {
        // List local skills
        const skills = await import('../../skills/index.js');
        const discovered = await skills.discoverSkills(fs);

        if (discovered.length === 0) {
          return {
            stdout: `No discoverable local skills found.\n\n${formatDiscoveryScope()}${formatManagementScope()}`,
            stderr: '',
            exitCode: 0,
          };
        }

        return {
          stdout: formatDiscoveredSkills(discovered, 'Discoverable local skills'),
          stderr: '',
          exitCode: 0,
        };
      } else if (arg === 'info' || arg === 'read') {
        // Delegate to skills module
        const skillName = args[i + 1];
        if (!skillName) {
          return {
            stdout: '',
            stderr: `upskill: ${arg} requires a skill name\n`,
            exitCode: 1,
          };
        }

        const skills = await import('../../skills/index.js');
        if (arg === 'info') {
          const skill = await skills.getSkillInfo(fs, skillName);
          if (!skill) {
            return {
              stdout: '',
              stderr: `upskill: skill "${skillName}" not found\n`,
              exitCode: 1,
            };
          }

          return { stdout: formatSkillInfo(skill), stderr: '', exitCode: 0 };
        } else {
          const instructions = await skills.readSkillInstructions(fs, skillName);
          if (instructions === null) {
            return {
              stdout: '',
              stderr: `upskill: no SKILL.md found for "${skillName}"\n`,
              exitCode: 1,
            };
          }
          return { stdout: instructions + '\n', stderr: '', exitCode: 0 };
        }
      } else if (arg === '--skill') {
        selectedSkills.push(args[++i]);
      } else if (arg === '--path' || arg === '-p') {
        subPath = args[++i];
      } else if (arg === '--list') {
        listOnly = true;
      } else if (arg === '--all') {
        installAll = true;
      } else if (arg === '--force') {
        force = true;
      } else if (!arg.startsWith('-')) {
        sourceRef = arg;
      }
      i++;
    }

    // Handle search
    if (searchQuery) {
      return searchClawHub(searchQuery, fetchFn);
    }

    if (!sourceRef) {
      return upskillHelp();
    }

    // Check if it's a ClawHub reference
    const clawHubSlug = parseClawHubRef(sourceRef);
    if (clawHubSlug) {
      return installFromClawHub(clawHubSlug, fs, fetchFn, force);
    }

    // Check if it's a GitHub reference
    const githubRef = parseGitHubRef(sourceRef);
    if (githubRef) {
      const { owner, repo } = githubRef;

      // List skills in the repository
      const result = await listGitHubSkills(owner, repo, fetchFn, subPath);

      if (result.error) {
        return {
          stdout: '',
          stderr: `upskill: failed to list skills: ${result.error}\n`,
          exitCode: 1,
        };
      }

      if (result.skills.length === 0) {
        return {
          stdout: `No skills found in ${owner}/${repo}${subPath ? '/' + subPath : ''}\n`,
          stderr: '',
          exitCode: 0,
        };
      }

      // Just list if --list flag
      if (listOnly) {
        let output = `Available skills in ${owner}/${repo}:\n\n`;
        for (const skill of result.skills) {
          output += `  ${skill.name.padEnd(30)} ${skill.path}\n`;
        }
        output += `\nFound ${result.skills.length} skill(s)\n`;
        output += `\nTo install: upskill ${sourceRef} --skill <name>\n`;
        output += `To install all: upskill ${sourceRef} --all\n`;
        return { stdout: output, stderr: '', exitCode: 0 };
      }

      // Determine which skills to install
      let skillsToInstall = result.skills;

      if (selectedSkills.length > 0) {
        skillsToInstall = result.skills.filter((s) =>
          selectedSkills.includes(s.name)
        );

        // Check for missing skills
        for (const name of selectedSkills) {
          if (!result.skills.find((s) => s.name === name)) {
            return {
              stdout: '',
              stderr: `upskill: skill "${name}" not found in ${owner}/${repo}\n`,
              exitCode: 1,
            };
          }
        }
      } else if (!installAll) {
        // No selection made - show list and prompt
        let output = `Available skills in ${owner}/${repo}:\n\n`;
        for (const skill of result.skills) {
          output += `  ${skill.name.padEnd(30)} ${skill.path}\n`;
        }
        output += `\nFound ${result.skills.length} skill(s)\n`;
        output += `\nTo install specific skills: upskill ${sourceRef} --skill <name>\n`;
        output += `To install all: upskill ${sourceRef} --all\n`;
        return { stdout: output, stderr: '', exitCode: 0 };
      }

      // Install selected skills
      let output = '';
      let errors = '';
      let successCount = 0;

      for (const skill of skillsToInstall) {
        const installResult = await installFromGitHub(
          owner,
          repo,
          skill.path,
          skill.name,
          fs,
          fetchFn,
          force
        );

        if (installResult.exitCode === 0) {
          output += installResult.stdout;
          successCount++;
        } else {
          errors += installResult.stderr;
        }
      }

      if (successCount > 0) {
        output += `\nInstalled ${successCount} skill(s)\n`;
        await refreshSprinklesAfterInstall();
      }

      return {
        stdout: output,
        stderr: errors,
        exitCode: errors ? 1 : 0,
      };
    }

    // Unknown source format
    return {
      stdout: '',
      stderr: `upskill: unrecognized source "${sourceRef}"\n\nExpected: owner/repo, https://clawhub.ai/user/skill, or clawhub:user/skill\n`,
      exitCode: 1,
    };
  });
}

/**
 * Create skill command as an alias for upskill with local operations only.
 */
export function createSkillCommand(fs: VirtualFS): Command {
  return defineCommand('skill', async (args, _ctx: CommandContext) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return {
        stdout: `usage: skill <command> [options]

Commands:
  list                   List discoverable skills and management status
  info <name>            Show details about a skill
  read <name>            Read the SKILL.md instructions
  install <name>         Install a native /workspace/skills skill (apply manifest)
  uninstall <name>       Uninstall a native /workspace/skills skill

${formatDiscoveryScope()}${formatManagementScope()}

For installing skills from GitHub or ClawHub, use 'upskill':
  upskill search "query"           Search ClawHub
  upskill owner/repo --list        List skills in GitHub repo
  upskill owner/repo --all         Install from GitHub

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
    const skills = await import('../../skills/index.js');

    try {
      switch (subcommand) {
        case 'list': {
          const discovered = await skills.discoverSkills(fs);

          if (discovered.length === 0) {
            return {
              stdout: `No discoverable skills found.\n\n${formatDiscoveryScope()}${formatManagementScope()}\nInstall install-managed skills with: upskill owner/repo --all\n`,
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

        case 'install': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'skill: install requires a skill name\n', exitCode: 1 };
          }

          const discovered = await skills.getSkillInfo(fs, name);
          if (discovered && !isInstallManagedSkill(discovered)) {
            return {
              stdout: '',
              stderr: formatCompatibilityMutationError('skill', discovered),
              exitCode: 1,
            };
          }

          const result = await skills.applySkill(fs, name);
          if (result.success) {
            await refreshSprinklesAfterInstall();
            return { stdout: `Installed skill "${result.skill}" v${result.version}\n`, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: `skill: ${result.error}\n`, exitCode: 1 };
        }

        case 'uninstall': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'skill: uninstall requires a skill name\n', exitCode: 1 };
          }

          const discovered = await skills.getSkillInfo(fs, name);

          const result = await skills.uninstallSkill(fs, name);
          if (result.success) {
            return { stdout: `Uninstalled skill "${result.skill}"\n`, stderr: '', exitCode: 0 };
          }

          if (discovered && !isInstallManagedSkill(discovered) && result.error?.includes('not installed')) {
            return {
              stdout: '',
              stderr: formatCompatibilityMutationError('skill', discovered),
              exitCode: 1,
            };
          }

          return { stdout: '', stderr: `skill: ${result.error}\n`, exitCode: 1 };
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
