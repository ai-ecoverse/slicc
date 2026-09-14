import { findFileMentions } from './file-mentions.js';

export const TOOL_PATH_HINTS_ATTR = 'data-file-paths';

const MAX_STRINGS = 24;

const MAX_STRING_LENGTH = 4000;

const MAX_HINTS_PER_CALL = 8;

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

function collectStrings(input: unknown, depth: number, out: string[]): void {
  if (out.length >= MAX_STRINGS) return;
  if (typeof input === 'string') {
    out.push(input.length > MAX_STRING_LENGTH ? input.slice(0, MAX_STRING_LENGTH) : input);
    return;
  }
  if (depth >= 2 || input === null || typeof input !== 'object') return;
  const values = Array.isArray(input) ? input : Object.values(input);
  for (const value of values) collectStrings(value, depth + 1, out);
}

export function toolCallPathHints(call: { input?: unknown }): string[] {
  const strings: string[] = [];
  collectStrings(call.input, 0, strings);

  const hints: string[] = [];
  const seen = new Set<string>();
  for (const raw of strings) {
    const text = raw.replace(URL_RE, ' ');
    for (const mention of findFileMentions(text)) {
      if (!mention.path.includes('/')) continue;
      if (seen.has(mention.path)) continue;
      seen.add(mention.path);
      hints.push(mention.path);
      if (hints.length >= MAX_HINTS_PER_CALL) return hints;
    }
  }
  return hints;
}

export function formatPathHints(hints: string[]): string | null {
  return hints.length > 0 ? JSON.stringify(hints) : null;
}

export function parsePathHints(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}
