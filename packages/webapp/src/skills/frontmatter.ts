export interface SkillFrontmatter {
  name?: string;
  description?: string;
  allowedTools?: string[];
  layout?: string;
  theme?: string;
}

const SCALAR_KEYS = new Set(['name', 'description', 'layout', 'theme', 'allowed-tools']);

export function splitSkillDocument(content: string): { frontmatter: string; body: string } | null {
  const normalized = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trimStart();
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n([\s\S]*))?$/);
  if (!match) return null;
  return { frontmatter: match[1], body: match[2] ?? '' };
}

export function parseSkillFrontmatter(content: string): {
  metadata: SkillFrontmatter;
  body: string;
} {
  const split = splitSkillDocument(content);
  if (!split) return { metadata: {}, body: content };
  return { metadata: parseSkillFrontmatterFields(split.frontmatter), body: split.body };
}

export function parseSkillFrontmatterFields(yamlStr: string): SkillFrontmatter {
  const metadata: SkillFrontmatter = {};
  const lines = yamlStr.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (!SCALAR_KEYS.has(key)) continue;

    const { value, lastIndex } = parseYamlStringValue(raw.trim(), lines, i + 1);
    i = lastIndex;

    switch (key) {
      case 'name':
        metadata.name = value;
        break;
      case 'description':
        metadata.description = value;
        break;
      case 'allowed-tools':
        metadata.allowedTools = value
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        break;
      case 'layout':
        metadata.layout = value;
        break;
      case 'theme':
        metadata.theme = value;
        break;
    }
  }

  return metadata;
}

export function extractSkillDescription(content: string): string | null {
  const { metadata } = parseSkillFrontmatter(content);
  return metadata.description ?? null;
}

export function parseYamlStringValue(
  rawValue: string,
  lines: string[],
  start: number
): { value: string; lastIndex: number } {
  const block = rawValue.match(/^([>|])[+-]?$/);
  if (block) {
    return collectBlockScalar(lines, start, block[1] === '>' ? ' ' : '\n');
  }
  return { value: unquoteScalar(rawValue), lastIndex: start - 1 };
}

function unquoteScalar(value: string): string {
  const q = value[0];
  if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
    const inner = value.slice(1, -1);
    return q === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'");
  }
  return value;
}

function collectBlockScalar(
  lines: string[],
  start: number,
  separator: string
): { value: string; lastIndex: number } {
  const collected: string[] = [];
  let lastIndex = start - 1;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.trim() === '') {
      lastIndex = i;
      continue;
    }
    if (!/^\s/.test(line)) break;
    collected.push(line.trim());
    lastIndex = i;
  }
  return { value: collected.join(separator), lastIndex };
}
