import type { VirtualFS } from '../fs/index.js';

export const GLOBAL_GITCONFIG_PATH = '/workspace/.gitconfig';

const SECTION_HEADER_RE = /^\[(\w+)(?:\s+"([^"]*)")?\]$/;
const KEY_EQUALS_RE = /^(\w+)\s*=/;
const KEY_VALUE_RE = /^(\w+)\s*=\s*(.*)$/;

function parseConfigKey(key: string): { section: string; configKey: string } {
  const parts = key.split('.');
  const configKey = parts.pop() ?? '';
  return { section: parts.join('.'), configKey };
}

function sectionNameFromHeader(trimmed: string): string | undefined {
  const sectionMatch = trimmed.match(SECTION_HEADER_RE);
  if (!sectionMatch) return undefined;
  const sec = sectionMatch[1].toLowerCase();
  const sub = sectionMatch[2] ?? '';
  return sub ? `${sec}.${sub}` : sec;
}

function formatSectionHeader(section: string): string {
  const sectionParts = section.split('.');
  if (sectionParts.length > 1) {
    return `[${sectionParts[0]} "${sectionParts.slice(1).join('.')}"]`;
  }
  return `[${section}]`;
}

function formatKeyLine(configKey: string, value: string): string {
  return `\t${configKey} = ${value}`;
}

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

  const { section, configKey } = parseConfigKey(key);
  let currentSection = '';
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const header = sectionNameFromHeader(line);
    if (header !== undefined) {
      currentSection = header;
      continue;
    }
    if (currentSection !== section) continue;
    const kvMatch = line.match(KEY_VALUE_RE);
    if (kvMatch && kvMatch[1] === configKey) {
      return kvMatch[2].trim();
    }
  }
  return undefined;
}

function updateExistingKey(
  lines: string[],
  section: string,
  configKey: string,
  value: string
): boolean {
  let currentSection = '';
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const header = sectionNameFromHeader(trimmed);
    if (header !== undefined) {
      currentSection = header;
      continue;
    }
    if (currentSection !== section) continue;
    const kvMatch = trimmed.match(KEY_EQUALS_RE);
    if (kvMatch && kvMatch[1] === configKey) {
      lines[i] = formatKeyLine(configKey, value);
      return true;
    }
  }
  return false;
}

function sectionExistsIn(lines: string[], section: string): boolean {
  for (const line of lines) {
    if (sectionNameFromHeader(line.trim()) === section) return true;
  }
  return false;
}

function insertKeyUnderSection(
  lines: string[],
  section: string,
  configKey: string,
  value: string
): void {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (sectionNameFromHeader(lines[i].trim()) !== section) continue;
    lines.splice(i + 1, 0, formatKeyLine(configKey, value));
    return;
  }
}

function appendNewSection(
  content: string,
  section: string,
  configKey: string,
  value: string
): string {
  const sectionHeader = formatSectionHeader(section);
  const keyLine = formatKeyLine(configKey, value);
  if (content) {
    return content.trimEnd() + `\n${sectionHeader}\n${keyLine}\n`;
  }
  return `${sectionHeader}\n${keyLine}\n`;
}

export async function writeGlobalGitConfigValue(
  fs: VirtualFS,
  key: string,
  value: string
): Promise<void> {
  let content = '';
  try {
    content = await fs.readTextFile(GLOBAL_GITCONFIG_PATH);
  } catch {}

  const { section, configKey } = parseConfigKey(key);
  const lines = content.split('\n');

  if (updateExistingKey(lines, section, configKey, value)) {
    await fs.writeFile(GLOBAL_GITCONFIG_PATH, lines.join('\n'));
    return;
  }

  if (sectionExistsIn(lines, section)) {
    insertKeyUnderSection(lines, section, configKey, value);
    await fs.writeFile(GLOBAL_GITCONFIG_PATH, lines.join('\n'));
    return;
  }

  await fs.writeFile(GLOBAL_GITCONFIG_PATH, appendNewSection(content, section, configKey, value));
}

export function removeGitConfigKey(content: string, key: string): string {
  const { section: targetSection, configKey: targetKey } = parseConfigKey(key);
  const lines = content.split('\n');
  const result: string[] = [];
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    const header = sectionNameFromHeader(trimmed);
    if (header !== undefined) {
      currentSection = header;
      result.push(line);
      continue;
    }

    if (currentSection === targetSection) {
      const kvMatch = trimmed.match(KEY_EQUALS_RE);
      if (kvMatch && kvMatch[1] === targetKey) {
        continue;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}
