export type FrontmatterValue = string | string[];

export interface FrontmatterSchema {
  arrayKeys: ReadonlySet<string>;

  scalarKeys: ReadonlySet<string>;
}

export interface InstructionDocument {
  frontmatter: string;
  body: string;
}

export function splitInstructionDocument(content: string, label: string): InstructionDocument {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match?.[2].trim()) throw new Error(`${label} requires frontmatter and a prompt`);
  return { frontmatter: match[1], body: match[2].trim() };
}

export function parseFrontmatter(
  frontmatter: string,
  schema: FrontmatterSchema
): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {};
  const lines = frontmatter.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const keyMatch = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (!keyMatch) throw new Error(`Invalid frontmatter line: ${line}`);
    const [, key, rest] = keyMatch;
    if (schema.arrayKeys.has(key)) {
      const parsed = parseArrayValue(lines, index, rest);
      result[key] = parsed.value;
      index = parsed.lastIndex;
    } else if (schema.scalarKeys.has(key) && rest.trim()) {
      result[key] = parseScalar(rest);
    } else {
      throw new Error(`Unsupported or empty frontmatter field: ${key}`);
    }
  }
  return result;
}

function parseArrayValue(
  lines: string[],
  keyIndex: number,
  inline: string
): { value: string[]; lastIndex: number } {
  if (inline.trim()) {
    const value = inline.trim();
    if (!value.startsWith('[') || !value.endsWith(']')) throw new Error('Expected an array');
    const inner = value.slice(1, -1).trim();
    return {
      value: inner ? splitInlineArray(inner) : [],
      lastIndex: keyIndex,
    };
  }
  const value: string[] = [];
  let lastIndex = keyIndex;
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const item = lines[index].match(/^\s+-\s+(.+)$/);
    if (!item) break;
    value.push(parseScalar(stripBlockArrayComment(item[1])));
    lastIndex = index;
  }
  return { value, lastIndex };
}

function splitInlineArray(inner: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '"' || char === "'") {
      quote = quote === char ? undefined : (quote ?? char);
    } else if (char === ',' && !quote) {
      items.push(parseScalar(inner.slice(start, index)));
      start = index + 1;
    }
  }
  if (quote) throw new Error('Unclosed quoted value');
  items.push(parseScalar(inner.slice(start)));
  return items;
}

function stripBlockArrayComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"' || char === "'") {
      quote = quote === char ? undefined : (quote ?? char);
    } else if (char === '#' && !quote && (index === 0 || /\s/.test(raw[index - 1]))) {
      return raw.slice(0, index).trimEnd();
    }
  }
  return raw;
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('Empty frontmatter value');
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) return value.slice(1, -1);
  if (quote === '"' || quote === "'") throw new Error('Unclosed quoted value');
  return value;
}

export function readArray(
  values: Record<string, FrontmatterValue>,
  key: string,
  fallback: string[]
): string[] {
  const value = values[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => !item)) throw new Error(`${key} is invalid`);
  return [...value];
}

export function readOptionalString(
  value: FrontmatterValue | undefined,
  key: string
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) throw new Error(`${key} is invalid`);
  return value;
}

export function readBoundedTimeout(
  value: FrontmatterValue | undefined,
  fallback: number,
  max: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error('timeoutSeconds is invalid');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('timeoutSeconds must be positive');
  return Math.min(parsed, max);
}

export function validatePaths(paths: string[], key: string): void {
  if (
    paths.some(
      (path) =>
        !path.startsWith('/') || path.includes('\0') || (key === 'writablePaths' && path === '/')
    )
  ) {
    throw new Error(`${key} must contain absolute VFS paths`);
  }
}
