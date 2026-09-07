/**
 * Syntax highlighting for fenced code blocks in the transcript.
 *
 * ## Tokenize raw, escape on emit
 *
 * The one rule this module exists to enforce: language rules run over the
 * ORIGINAL source, and each token's text is HTML-escaped exactly once as it is
 * written out. Highlighting escaped markup instead is the bug this replaced —
 * `escapeHtml('…')` turns a quote into `&#39;`, so a `'…'` rule matched from
 * the tail of one entity to the tail of the next (highlighting the gaps
 * BETWEEN strings), a `#` rule saw a comment inside every `&#39;`, and a
 * number rule split `&#39;` into `&#<span>39</span>;`, which renders as a
 * literal `&#39;`. Nothing downstream can repair that, because by then token
 * text and markup are the same characters.
 *
 * A single pass of one combined regex per language does the tokenizing:
 * leftmost match wins, and among alternatives starting at the same index the
 * first one listed wins. So `'https://x'` is a string (the string alternative
 * starts earlier than `//`) while `// it's fine` is all comment.
 */

import { escapeHtml } from '@slicc/webcomponents/internal/html';

/** Token classes; each maps to a `.tok-<name>` rule in `styles/tokens.css`. */
const TOKEN_TYPES = ['comment', 'string', 'keyword', 'number', 'fn'] as const;

const JS_KEYWORDS = [
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'class',
  'extends',
  'import',
  'export',
  'from',
  'default',
  'new',
  'this',
  'async',
  'await',
  'try',
  'catch',
  'throw',
  'typeof',
  'instanceof',
  'interface',
  'type',
  'enum',
  'implements',
  'abstract',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'void',
  'null',
  'undefined',
  'true',
  'false',
];

const BASH_KEYWORDS = [
  'if',
  'then',
  'else',
  'fi',
  'for',
  'do',
  'done',
  'while',
  'case',
  'esac',
  'echo',
  'export',
  'cd',
  'ls',
  'mkdir',
  'rm',
  'cp',
  'mv',
  'cat',
  'grep',
  'npm',
  'node',
  'git',
];

/** `'a\'b'` / `"a\"b"` — quoted runs that respect backslash escapes. */
const JS_STRING = String.raw`'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|\`(?:\\.|[^\`\\])*\``;

const JS_PATTERN = new RegExp(
  [
    String.raw`(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/)`,
    `(?<string>${JS_STRING})`,
    String.raw`(?<keyword>\b(?:${JS_KEYWORDS.join('|')})\b)`,
    String.raw`(?<number>\b\d+(?:\.\d*)?\b)`,
    String.raw`(?<fn>\b[A-Za-z_$][\w$]*(?=\s*\())`,
  ].join('|'),
  'g'
);

// A JSON key is a string followed by a colon; everything else quoted is a
// value. Both share one `keyword`/`string` split so the two never overlap.
const JSON_STRING = String.raw`"(?:\\.|[^"\\])*"`;

const JSON_PATTERN = new RegExp(
  [
    String.raw`(?<keyword>${JSON_STRING}(?=\s*:)|\b(?:true|false|null)\b)`,
    `(?<string>${JSON_STRING})`,
    String.raw`(?<number>-?\b\d+(?:\.\d*)?\b)`,
  ].join('|'),
  'g'
);

// `#` only opens a comment at the start of a word — `foo#bar` and `#!/bin/sh`
// both matter, but `${x#prefix}` and a URL fragment are not comments.
const BASH_PATTERN = new RegExp(
  [
    String.raw`(?<comment>(?<![^\s])#[^\n]*)`,
    String.raw`(?<string>'[^'\n]*'|"(?:\\.|[^"\\\n])*")`,
    String.raw`(?<keyword>\b(?:${BASH_KEYWORDS.join('|')})\b)`,
  ].join('|'),
  'g'
);

/** The token class a match landed in, or `undefined` for a zero-width hit. */
function matchedType(groups: Record<string, string | undefined>): string | undefined {
  return TOKEN_TYPES.find((type) => groups[type] !== undefined);
}

/**
 * Run one combined pattern over `code`, wrapping matches and escaping
 * everything (matched and unmatched alike) on the way out.
 */
function highlightWith(code: string, pattern: RegExp): string {
  let out = '';
  let cursor = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
    // A zero-width match would spin the loop forever; no alternative above can
    // produce one, so this is belt-and-braces for future rules.
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    const type = matchedType(match.groups ?? {});
    if (type === undefined) continue;
    out += escapeHtml(code.slice(cursor, match.index));
    out += `<span class="tok-${type}">${escapeHtml(match[0])}</span>`;
    cursor = match.index + match[0].length;
  }
  return out + escapeHtml(code.slice(cursor));
}

const JS_LANGS = new Set(['js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx']);
const BASH_LANGS = new Set(['bash', 'sh', 'shell', 'zsh']);

/**
 * Highlight a fenced code block, returning HTML-escaped markup ready to drop
 * inside `<pre><code>`. Unknown languages are escaped and returned as-is.
 *
 * `shtml` is escaped but never tokenized: dip hydration reads that block's
 * text back out as markup, so highlighting spans would land in the dip.
 */
export function highlightCode(code: string, lang: string): string {
  if (lang === 'shtml') return escapeHtml(code);
  if (JS_LANGS.has(lang)) return highlightWith(code, JS_PATTERN);
  if (lang === 'json') return highlightWith(code, JSON_PATTERN);
  if (BASH_LANGS.has(lang)) return highlightWith(code, BASH_PATTERN);
  return escapeHtml(code);
}
