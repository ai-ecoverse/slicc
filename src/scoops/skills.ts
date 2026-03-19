/**
 * Skills System - loads and manages skills that can modify agent behavior.
 *
 * Skills are markdown files with YAML frontmatter that define:
 * - name: skill identifier
 * - description: what the skill does
 * - allowed-tools: optional tool restrictions (e.g., "Bash(agent-browser:*)")
 *
 * Skills provide instructions that the agent can follow.
 */

import { createLogger } from '../core/logger.js';
import type { VirtualFS } from '../fs/index.js';
import { discoverSkills } from '../skills/index.js';

const log = createLogger('skills');

// Load default text files at build time using import.meta.glob
// The '?raw' query imports file contents as strings
const defaultTextFiles = import.meta.glob(
  '/src/defaults/**/*.{md,jsh,shtml,json,txt,css,js,ts,html}',
  {
    query: '?raw',
    import: 'default',
    eager: true,
  }
) as Record<string, string>;

// Load default binary files (audio, images, etc.) as base64
// The '?inline' query gives us a data URL we can decode
const defaultBinaryFiles = import.meta.glob(
  '/src/defaults/**/*.{mp3,wav,ogg,png,jpg,jpeg,gif,webp,ico,pdf}',
  {
    query: '?inline',
    import: 'default',
    eager: true,
  }
) as Record<string, string>;

// Binary file extensions that need special handling
const BINARY_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.ogg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
]);

function isBinaryFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  // data:audio/mpeg;base64,AAAA...
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Combined view of all default files
function getDefaultFiles(): Record<string, string | Uint8Array> {
  const result: Record<string, string | Uint8Array> = {};

  // Add text files as-is
  for (const [path, content] of Object.entries(defaultTextFiles)) {
    result[path] = content;
  }

  // Add binary files decoded from data URLs
  for (const [path, dataUrl] of Object.entries(defaultBinaryFiles)) {
    result[path] = decodeDataUrl(dataUrl);
  }

  return result;
}

export interface SkillMetadata {
  name: string;
  description: string;
  allowedTools?: string[];
}

export interface Skill {
  metadata: SkillMetadata;
  content: string;
  path: string;
}

function dedupeSkillsByName(skills: Skill[]): Skill[] {
  const winners = new Map<string, Skill>();

  for (const skill of skills) {
    if (winners.has(skill.metadata.name)) {
      log.debug('Skipped shadowed runtime skill', {
        name: skill.metadata.name,
        path: skill.path,
        winnerPath: winners.get(skill.metadata.name)?.path,
      });
      continue;
    }

    winners.set(skill.metadata.name, skill);
  }

  return Array.from(winners.values());
}

/**
 * Parse YAML frontmatter from a skill file
 */
function parseFrontmatter(content: string): { metadata: Partial<SkillMetadata>; body: string } {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

  if (!frontmatterMatch) {
    return { metadata: {}, body: content };
  }

  const [, yamlStr, body] = frontmatterMatch;
  const metadata: Partial<SkillMetadata> = {};

  // Simple YAML parsing for our expected keys
  for (const line of yamlStr.split('\n')) {
    const match = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!match) continue;

    const [, key, value] = match;
    const trimmedValue = value.trim();

    switch (key) {
      case 'name':
        metadata.name = trimmedValue;
        break;
      case 'description':
        metadata.description = trimmedValue;
        break;
      case 'allowed-tools':
        metadata.allowedTools = trimmedValue.split(',').map((t) => t.trim());
        break;
    }
  }

  return { metadata, body };
}

/**
 * Load skills from a directory in VirtualFS
 */
export async function loadSkills(fs: VirtualFS, skillsDir: string): Promise<Skill[]> {
  const discoveredSkills = await loadDiscoveredSkills(fs, skillsDir);
  const standaloneSkills = await loadStandaloneMarkdownSkills(fs, skillsDir);
  const skills = dedupeSkillsByName([...discoveredSkills, ...standaloneSkills]);

  log.info('Skills loaded', { count: skills.length, dir: skillsDir });
  return skills;
}

async function loadDiscoveredSkills(fs: VirtualFS, skillsDir: string): Promise<Skill[]> {
  const discovered = await discoverSkills(fs, skillsDir);
  const skills: Skill[] = [];

  for (const discoveredSkill of discovered) {
    if (!discoveredSkill.skillFilePath) continue;

    try {
      const text = await fs.readTextFile(discoveredSkill.skillFilePath);
      const { metadata, body } = parseFrontmatter(text);

      skills.push({
        metadata: {
          name: discoveredSkill.name,
          description: metadata.description || discoveredSkill.manifest.description || '',
          allowedTools: metadata.allowedTools,
        },
        content: body,
        path: discoveredSkill.skillFilePath,
      });
      log.debug('Loaded discovered skill', {
        name: discoveredSkill.name,
        path: discoveredSkill.skillFilePath,
        source: discoveredSkill.source,
      });
    } catch {
      log.debug('Failed to load discovered skill', {
        name: discoveredSkill.name,
        path: discoveredSkill.skillFilePath,
      });
    }
  }

  return skills;
}

async function loadStandaloneMarkdownSkills(fs: VirtualFS, skillsDir: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  try {
    const entries = await fs.readDir(skillsDir);

    for (const entry of entries) {
      if (entry.type === 'file' && entry.name.endsWith('.md')) {
        // Skills can also be standalone .md files
        const skillPath = `${skillsDir}/${entry.name}`;
        try {
          const content = await fs.readFile(skillPath, { encoding: 'utf-8' });
          const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
          const { metadata, body } = parseFrontmatter(text);

          // Use filename as name if not in frontmatter
          const name = metadata.name || entry.name.replace('.md', '');

          skills.push({
            metadata: {
              name,
              description: metadata.description || '',
              allowedTools: metadata.allowedTools,
            },
            content: body,
            path: skillPath,
          });
          log.debug('Loaded standalone skill', { name, path: skillPath });
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch (err) {
    // Skills directory doesn't exist yet
    log.debug('Standalone skills directory not found', { dir: skillsDir });
  }

  return skills;
}

/**
 * Format skills into a system prompt section.
 * Only includes headers to preserve context - full content can be read on demand.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const sections = skills.map((skill) => {
    const toolsLine = skill.metadata.allowedTools
      ? `  Allowed tools: ${skill.metadata.allowedTools.join(', ')}\n`
      : '';
    return `- **${skill.metadata.name}**: ${skill.metadata.description}\n${toolsLine}  Path: ${skill.path}`;
  });

  return `
---
AVAILABLE SKILLS

The following skills are available. To use a skill, first read its full instructions:
  read_file({ "path": "<skill path>" })

${sections.join('\n')}
---`;
}

/**
 * Create default files in VFS from bundled defaults.
 * Files are loaded from src/defaults/ at build time via import.meta.glob.
 */
export async function createDefaultSkills(
  fs: VirtualFS,
  skillsDir: string = '/workspace/skills'
): Promise<void> {
  const prefix = '/src/defaults';
  const defaultFiles = getDefaultFiles();

  for (const [importPath, content] of Object.entries(defaultFiles)) {
    // Convert import path like '/src/defaults/workspace/skills/browser/SKILL.md'
    // to VFS path like '/workspace/skills/browser/SKILL.md'
    const vfsPath = importPath.slice(prefix.length);

    // Copy files under /workspace/skills and /workspace/scripts
    const isSkill = vfsPath.startsWith('/workspace/skills');
    const isScript = vfsPath.startsWith('/workspace/scripts');
    if (!isSkill && !isScript) continue;

    // Adjust path if skillsDir is different (e.g., for scoops)
    let targetPath = vfsPath;
    if (isSkill && skillsDir !== '/workspace/skills') {
      targetPath = vfsPath.replace('/workspace/skills', skillsDir);
    }
    if (isScript && skillsDir !== '/workspace/skills') {
      // For scoops: /workspace/scripts → /scoops/{folder}/workspace/scripts
      const scoopBase = skillsDir.replace('/workspace/skills', '');
      targetPath = scoopBase + vfsPath;
    }

    try {
      // Check if file already exists
      await fs.stat(targetPath);
      // File exists, skip
    } catch {
      // File doesn't exist, create it
      const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
      try {
        await fs.mkdir(parentDir, { recursive: true });
      } catch {
        // Directory exists
      }
      await fs.writeFile(targetPath, content);
      log.info('Created default file', { path: targetPath });
    }
  }
}

/**
 * Create default shared files (like /shared/CLAUDE.md) from bundled defaults.
 */
export async function createDefaultSharedFiles(fs: VirtualFS): Promise<void> {
  const prefix = '/src/defaults';
  const defaultFiles = getDefaultFiles();

  for (const [importPath, content] of Object.entries(defaultFiles)) {
    const vfsPath = importPath.slice(prefix.length);

    // Only copy files that belong under /shared/
    if (!vfsPath.startsWith('/shared/')) continue;

    try {
      // Check if file already exists
      await fs.stat(vfsPath);
      // File exists, skip
    } catch {
      // File doesn't exist, create it
      const parentDir = vfsPath.substring(0, vfsPath.lastIndexOf('/'));
      try {
        await fs.mkdir(parentDir, { recursive: true });
      } catch {
        // Directory exists
      }
      await fs.writeFile(vfsPath, content);
      log.info('Created default shared file', { path: vfsPath });
    }
  }
}
