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

const log = createLogger('skills');

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
        metadata.allowedTools = trimmedValue.split(',').map(t => t.trim());
        break;
    }
  }

  return { metadata, body };
}

/**
 * Load skills from a directory in VirtualFS
 */
export async function loadSkills(fs: VirtualFS, skillsDir: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  try {
    const entries = await fs.readDir(skillsDir);
    
    for (const entry of entries) {
      if (entry.type === 'directory') {
        // Skills can be in subdirectories with SKILL.md
        const skillPath = `${skillsDir}/${entry.name}/SKILL.md`;
        try {
          const content = await fs.readFile(skillPath, { encoding: 'utf-8' });
          const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
          const { metadata, body } = parseFrontmatter(text);
          
          if (metadata.name) {
            skills.push({
              metadata: {
                name: metadata.name,
                description: metadata.description || '',
                allowedTools: metadata.allowedTools,
              },
              content: body,
              path: skillPath,
            });
            log.debug('Loaded skill', { name: metadata.name, path: skillPath });
          }
        } catch {
          // SKILL.md doesn't exist in this directory
        }
      } else if (entry.name.endsWith('.md')) {
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
          log.debug('Loaded skill', { name, path: skillPath });
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch (err) {
    // Skills directory doesn't exist yet
    log.debug('Skills directory not found', { dir: skillsDir });
  }

  log.info('Skills loaded', { count: skills.length, dir: skillsDir });
  return skills;
}

/**
 * Format skills into a system prompt section
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const sections = skills.map(skill => {
    const header = `## Skill: ${skill.metadata.name}
${skill.metadata.description}
${skill.metadata.allowedTools ? `\nAllowed tools: ${skill.metadata.allowedTools.join(', ')}` : ''}

`;
    return header + skill.content;
  });

  return `
---
AVAILABLE SKILLS
The following skills are available to you. Use them when appropriate.

${sections.join('\n\n---\n')}
---`;
}

/**
 * Create default skills for a new group
 */
export async function createDefaultSkills(fs: VirtualFS): Promise<void> {
  const skillsDir = '/workspace/group/.skills';
  
  try {
    await fs.mkdir(skillsDir, { recursive: true });
  } catch {
    // Directory exists
  }

  // Create browser skill
  const browserSkill = `---
name: browser
description: Browse the web, interact with pages, take screenshots, extract data. The browser tool provides playwright-style automation.
allowed-tools: browser
---

# Web Browser Automation

Use the \`browser\` tool to interact with web pages.

## Available Actions

- **navigate**: Go to a URL
  \`\`\`json
  { "action": "navigate", "url": "https://example.com" }
  \`\`\`

- **screenshot**: Capture the page
  \`\`\`json
  { "action": "screenshot" }
  \`\`\`

- **click**: Click an element
  \`\`\`json
  { "action": "click", "selector": "button.submit" }
  \`\`\`

- **type**: Enter text
  \`\`\`json
  { "action": "type", "selector": "input[name=email]", "text": "user@example.com" }
  \`\`\`

- **evaluate**: Run JavaScript
  \`\`\`json
  { "action": "evaluate", "code": "document.title" }
  \`\`\`

- **accessibility**: Get accessibility tree for understanding page structure

## Workflow

1. Navigate to the page
2. Take a screenshot or get accessibility tree to understand the page
3. Interact with elements
4. Repeat as needed
`;

  try {
    await fs.mkdir(`${skillsDir}/browser`, { recursive: true });
    await fs.writeFile(`${skillsDir}/browser/SKILL.md`, browserSkill);
    log.info('Created default browser skill');
  } catch {
    // Already exists
  }
}
