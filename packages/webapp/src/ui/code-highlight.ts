import { escapeHtml } from '@slicc/webcomponents/internal/html';

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

const JSON_STRING = String.raw`"(?:\\.|[^"\\])*"`;

const JSON_PATTERN = new RegExp(
  [
    String.raw`(?<keyword>${JSON_STRING}(?=\s*:)|\b(?:true|false|null)\b)`,
    `(?<string>${JSON_STRING})`,
    String.raw`(?<number>-?\b\d+(?:\.\d*)?\b)`,
  ].join('|'),
  'g'
);

const BASH_PATTERN = new RegExp(
  [
    String.raw`(?<comment>(?<![^\s])#[^\n]*)`,
    String.raw`(?<string>'[^'\n]*'|"(?:\\.|[^"\\\n])*")`,
    String.raw`(?<keyword>\b(?:${BASH_KEYWORDS.join('|')})\b)`,
  ].join('|'),
  'g'
);

function matchedType(groups: Record<string, string | undefined>): string | undefined {
  return TOKEN_TYPES.find((type) => groups[type] !== undefined);
}

function highlightWith(code: string, pattern: RegExp): string {
  let out = '';
  let cursor = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
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

export function highlightCode(code: string, lang: string): string {
  if (lang === 'shtml') return escapeHtml(code);
  if (JS_LANGS.has(lang)) return highlightWith(code, JS_PATTERN);
  if (lang === 'json') return highlightWith(code, JSON_PATTERN);
  if (BASH_LANGS.has(lang)) return highlightWith(code, BASH_PATTERN);
  return escapeHtml(code);
}
