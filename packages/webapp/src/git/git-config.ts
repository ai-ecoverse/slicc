/**
 * Shared helpers for reading and writing the global git config file at
 * `/workspace/.gitconfig` in the Global VirtualFS.
 *
 * Used by both `GitCommands` (for `git config --global` operations and
 * author-identity resolution) and the GitHub OAuth provider (for seeding
 * `user.name` / `user.email` after a successful login).
 *
 * Implements just enough of git's INI dialect for our needs: subsections
 * with `"name"` quoting, repeated section headers, and tab/space-indented
 * key=value pairs.
 */

import type { VirtualFS } from '../fs/index.js';

export const GLOBAL_GITCONFIG_PATH = '/workspace/.gitconfig';

/** Look up a `section.key` (or `section.subsection.key`) value. */
export async function readGlobalGitConfigValue(
  fs: VirtualFS,
  key: string
): Promise<string | undefined> {
  let content: string;
  try {
    content = await fs.readTextFile(GLOBAL_GITCONFIG_PATH);
  } catch {
    return undefined;
  }

  const parts = key.split('.');
  const configKey = parts.pop()!;
  const section = parts.join('.');

  let currentSection = '';
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[(\w+)(?:\s+"([^"]*)")?\]$/);
    if (sectionMatch) {
      const sec = sectionMatch[1].toLowerCase();
      const sub = sectionMatch[2] ?? '';
      currentSection = sub ? `${sec}.${sub}` : sec;
      continue;
    }
    if (currentSection === section) {
      const kvMatch = line.match(/^(\w+)\s*=\s*(.*)$/);
      if (kvMatch && kvMatch[1] === configKey) {
        return kvMatch[2].trim();
      }
    }
  }
  return undefined;
}

/** Set a `section.key` (or `section.subsection.key`) value, creating sections as needed. */
export async function writeGlobalGitConfigValue(
  fs: VirtualFS,
  key: string,
  value: string
): Promise<void> {
  let content = '';
  try {
    content = await fs.readTextFile(GLOBAL_GITCONFIG_PATH);
  } catch {
    /* file doesn't exist yet */
  }

  const parts = key.split('.');
  const configKey = parts.pop()!;
  const section = parts.join('.');

  const lines = content.split('\n');
  let currentSection = '';
  let sectionExists = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const sectionMatch = trimmed.match(/^\[(\w+)(?:\s+"([^"]*)")?\]$/);
    if (sectionMatch) {
      const sec = sectionMatch[1].toLowerCase();
      const sub = sectionMatch[2] ?? '';
      currentSection = sub ? `${sec}.${sub}` : sec;
      if (currentSection === section) sectionExists = true;
      continue;
    }

    if (currentSection === section) {
      const kvMatch = trimmed.match(/^(\w+)\s*=/);
      if (kvMatch && kvMatch[1] === configKey) {
        lines[i] = `\t${configKey} = ${value}`;
        await fs.writeFile(GLOBAL_GITCONFIG_PATH, lines.join('\n'));
        return;
      }
    }
  }

  if (sectionExists) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      const sectionMatch = trimmed.match(/^\[(\w+)(?:\s+"([^"]*)")?\]$/);
      if (sectionMatch) {
        const sec = sectionMatch[1].toLowerCase();
        const sub = sectionMatch[2] ?? '';
        const cs = sub ? `${sec}.${sub}` : sec;
        if (cs === section) {
          lines.splice(i + 1, 0, `\t${configKey} = ${value}`);
          break;
        }
      }
    }
    await fs.writeFile(GLOBAL_GITCONFIG_PATH, lines.join('\n'));
    return;
  }

  const sectionParts = section.split('.');
  const sectionHeader =
    sectionParts.length > 1
      ? `[${sectionParts[0]} "${sectionParts.slice(1).join('.')}"]`
      : `[${section}]`;
  const newContent = content
    ? content.trimEnd() + `\n${sectionHeader}\n\t${configKey} = ${value}\n`
    : `${sectionHeader}\n\t${configKey} = ${value}\n`;
  await fs.writeFile(GLOBAL_GITCONFIG_PATH, newContent);
}

/** Remove a key from a parsed git config INI string. */
export function removeGitConfigKey(content: string, key: string): string {
  const parts = key.split('.');
  const targetKey = parts.pop()!;
  const targetSection = parts.join('.');

  const lines = content.split('\n');
  const result: string[] = [];
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[(\w+)(?:\s+"([^"]*)")?\]$/);
    if (sectionMatch) {
      const sec = sectionMatch[1].toLowerCase();
      const sub = sectionMatch[2] ?? '';
      currentSection = sub ? `${sec}.${sub}` : sec;
      result.push(line);
      continue;
    }

    if (currentSection === targetSection) {
      const kvMatch = trimmed.match(/^(\w+)\s*=/);
      if (kvMatch && kvMatch[1] === targetKey) {
        continue;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}
