/**
 * File paths the agent has already NAMED IN A TOOL CALL.
 *
 * `core/file-mentions.ts` guesses file names out of prose and
 * `core/file-mention-resolver.ts` checks the guess against the VFS. That pair
 * has one blind spot: prose almost never carries a directory. When the agent
 * writes "I put it in foo.md", the basename index answers with every `foo.md`
 * in the workspace — or, if the file lives outside the indexed roots, with
 * nothing at all.
 *
 * The turn itself already contains the answer. A `bash` call reading
 * `echo "test" > /home/lars/foo.md`, or a `write_file` call whose `path` is
 * `/workspace/docs/foo.md`, says exactly which `foo.md` the following sentence
 * means. This module harvests those paths so the resolver can prefer them.
 *
 * ## Why every string, rather than a table of parameter names
 *
 * Tools are open-ended — built-ins, MCP servers, future ones — so a list of
 * "the fields that hold paths" would be stale the day it is written. Instead
 * every string in the input bag is scanned with the SAME heuristic used on
 * prose, and only candidates that carry a directory survive. That filter is
 * what makes the permissiveness safe in both directions: a hint without a
 * directory tells the resolver nothing the index did not already know, and a
 * hint that names a file which does not exist is dropped when it is verified.
 */

import { findFileMentions } from './file-mentions.js';

/** Attribute a rendered tool row carries its harvested paths in. */
export const TOOL_PATH_HINTS_ATTR = 'data-file-paths';

/** How many strings deep in one input bag are worth scanning. */
const MAX_STRINGS = 24;

/** Longest string scanned. A `write_file` body is content, not parameters. */
const MAX_STRING_LENGTH = 4000;

/** Hints kept per tool call, newest-first losers dropped. */
const MAX_HINTS_PER_CALL = 8;

/** `https://host/path.js` is a URL; its "path" is not a file on this machine. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Collect the strings inside a tool input bag.
 *
 * Shallow on purpose: parameters live at the top level or one array/object
 * deep, and descending further would mean walking arbitrary tool payloads for
 * diminishing returns.
 */
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

/**
 * Every directory-qualified file path named by one tool call.
 *
 * Returned in the order they appear, deduped, and capped. Nothing here checks
 * whether the paths exist — that is the resolver's job, and doing it here would
 * put a `stat()` on the render path of every tool row.
 */
export function toolCallPathHints(call: { input?: unknown }): string[] {
  const strings: string[] = [];
  collectStrings(call.input, 0, strings);

  const hints: string[] = [];
  const seen = new Set<string>();
  for (const raw of strings) {
    // Blank out URLs first: `https://example.com/app.js` would otherwise
    // contribute `example.com/app.js`, a hint that can never resolve.
    const text = raw.replace(URL_RE, ' ');
    for (const mention of findFileMentions(text)) {
      // A bare basename adds nothing the index does not already have — the
      // whole value of a hint is the directory it carries.
      if (!mention.path.includes('/')) continue;
      if (seen.has(mention.path)) continue;
      seen.add(mention.path);
      hints.push(mention.path);
      if (hints.length >= MAX_HINTS_PER_CALL) return hints;
    }
  }
  return hints;
}

/** Serialize hints for the `data-file-paths` attribute. Empty → `null`. */
export function formatPathHints(hints: string[]): string | null {
  return hints.length > 0 ? JSON.stringify(hints) : null;
}

/** Read hints back off an attribute value; malformed markup yields none. */
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
