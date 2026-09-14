import { basename, extname } from 'node:path';

const DIRECTIVE_RE =
  /(?:^#!)|@ts-(?:expect-error|ignore|nocheck|check)\b|biome-ignore\b|eslint-(?:disable|enable|global)|prettier-ignore|unused-dep-ok:|(?:@vite-ignore|vite-ignore|webpackIgnore)|@vitest-environment|#__PURE__|#__NO_SIDE_EFFECTS__|@__PURE__|@__NO_SIDE_EFFECTS__|<reference\s|source(?:MappingURL|URL)=|go:(?:build|generate|embed|noinline|norace|nosplit)\b|\+build\s|^export\s+[A-Za-z_][A-Za-z0-9_]*$|nolint\b|^line(?:\s+\S*)?:\d+(?::\d+)?$|swift-tools-version:|swiftlint:|swiftformat:|sourcery:|shellcheck\s|yamllint\s|istanbul\s+ignore|c8\s+ignore|v8\s+ignore|deno-lint-|gofmt:|fmt:off|fmt:on/i;

const JS_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.jsh',
  '.grit',
]);
const CSS_EXTS = new Set(['.css']);
const SWIFT_EXTS = new Set(['.swift']);
const GO_EXTS = new Set(['.go']);
const SHELL_EXTS = new Set(['.sh']);
const HASH_EXTS = new Set(['.yml', '.yaml']);
const HASH_NAMES = new Set([
  '.gitignore',
  '.npmrc',
  '.npmignore',
  '.prettierignore',
  '.editorconfig',
  '.gitattributes',
]);
const HTML_EXTS = new Set([
  '.html',
  '.shtml',
  '.svg',
  '.xml',
  '.plist',
  '.entitlements',
  '.xcprivacy',
]);
const JSON_EXTS = new Set(['.json', '.jsonc']);

const SKIP_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.mp3',
  '.wav',
  '.otf',
  '.ttf',
  '.woff',
  '.woff2',
  '.db',
  '.sum',
  '.resolved',
  '.patch',
  '.lock',
  '.gitkeep',
  '.mp4',
  '.pdf',
  '.zip',
]);

const SKIP_NAMES = new Set(['package-lock.json', 'LICENSE', 'go.sum', '.ds_store']);

export function isKeptComment(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#!')) return true;
  const body = trimmed
    .replace(/^\/\/\/?/, '')
    .replace(/^\/\*/, '')
    .replace(/\*\/$/, '')
    .replace(/^#/, '')
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .trim();
  return DIRECTIVE_RE.test(body) || DIRECTIVE_RE.test(trimmed);
}

export function languageForPath(relPath) {
  const base = basename(relPath);
  const lower = base.toLowerCase();
  if (SKIP_NAMES.has(lower)) return null;
  if (base === 'Makefile' || base === 'makefile' || base === 'GNUmakefile') return 'hash';
  if (base === 'go.mod') return 'go';
  if (base === '.swift-format') return 'json';
  if (relPath.startsWith('.husky/')) return 'hash';
  if (HASH_NAMES.has(lower)) return 'hash';
  const ext = extname(relPath).toLowerCase();
  if (SKIP_EXTS.has(ext)) return null;
  if (JS_EXTS.has(ext)) return 'js';
  if (CSS_EXTS.has(ext)) return 'css';
  if (SWIFT_EXTS.has(ext)) return 'swift';
  if (GO_EXTS.has(ext)) return 'go';
  if (SHELL_EXTS.has(ext)) return 'hash';
  if (HASH_EXTS.has(ext)) return 'hash';
  if (HTML_EXTS.has(ext)) return 'html';
  if (JSON_EXTS.has(ext)) return 'json';
  return null;
}

export function isProductMarkdown(relPath) {
  return relPath.startsWith('packages/vfs-root/') && /\.(md|shtml)$/.test(relPath);
}

export function isDeletedPath(relPath) {
  if (relPath === 'README.md' || relPath === 'LICENSE' || relPath === '.no-comment') return false;
  if (relPath.startsWith('packages/vfs-root/')) return false;
  const base = basename(relPath);
  if (base === 'CLAUDE.md' || base === 'AGENTS.md') return true;
  if (relPath.startsWith('.agents/')) return true;
  if (relPath.startsWith('.claude/')) return true;
  if (relPath.startsWith('.github/instructions/')) return true;
  if (relPath === '.github/copilot-instructions.md') return true;
  if (relPath === '.github/PULL_REQUEST_TEMPLATE.md') return true;
  if (relPath.startsWith('docs/') && relPath.endsWith('.md')) return true;
  if (relPath.endsWith('.md')) return true;
  return false;
}

function blankNonNewlines(text) {
  return text.replace(/[^\n]/g, '');
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function firstLine(text) {
  const trimmed = text.trim();
  const nl = trimmed.indexOf('\n');
  return nl === -1 ? trimmed : trimmed.slice(0, nl);
}

const REGEX_PREV = new Set([
  'start',
  '(',
  '[',
  '{',
  ',',
  ';',
  'op',
  'return',
  'throw',
  'case',
  'new',
  'void',
  'typeof',
  'delete',
  'else',
  'do',
  'in',
  'of',
  'await',
  'yield',
  'instanceof',
]);

const REGEX_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'new',
  'void',
  'typeof',
  'delete',
  'else',
  'do',
  'in',
  'of',
  'await',
  'yield',
  'instanceof',
]);

function emitComment(visit, raw, start) {
  visit(isKeptComment(raw) ? 'keep' : 'drop', raw, start);
}

function scanQuoted(source, start, quote) {
  let i = start + 1;
  const n = source.length;
  while (i < n) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) {
      i++;
      break;
    }
    i++;
  }
  return { text: source.slice(start, i), end: i };
}

function consumeLineComment(source, start, end, visit) {
  let i = start + 2;
  while (i < end && source[i] !== '\n') i++;
  emitComment(visit, source.slice(start, i), start);
  return i;
}

function consumeBlockComment(source, start, end, visit, nested) {
  let i = start + 2;
  let depth = 1;
  while (i < end && depth > 0) {
    if (nested && source[i] === '/' && source[i + 1] === '*') {
      depth++;
      i += 2;
      continue;
    }
    if (source[i] === '*' && source[i + 1] === '/') {
      depth--;
      i += 2;
      continue;
    }
    i++;
  }
  emitComment(visit, source.slice(start, i), start);
  return i;
}

function scanRegexLiteral(source, start, end) {
  let i = start + 1;
  let inClass = false;
  while (i < end) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[' && !inClass) inClass = true;
    else if (ch === ']' && inClass) inClass = false;
    else if (ch === '/' && !inClass) {
      i++;
      while (i < end && /[a-z]/i.test(source[i])) i++;
      return i;
    } else if (ch === '\n') return i;
    i++;
  }
  return i;
}

function consumeIdent(source, start, end, visit) {
  let i = start + 1;
  while (i < end && /[A-Za-z0-9_$]/.test(source[i])) i++;
  const ident = source.slice(start, i);
  visit('keep', ident, start);
  return { i, prev: REGEX_KEYWORDS.has(ident) ? ident : 'ident' };
}

function classifyPunct(ch) {
  if ('([{'.includes(ch)) return ch;
  if (',;'.includes(ch)) return ch;
  if ('=?:~!<>&|^%*+-'.includes(ch)) return 'op';
  if (ch === ')' || ch === ']' || ch === '}') return 'ident';
  if (/\s/.test(ch)) return null;
  return 'ident';
}

function consumeSlash(source, i, end, visit, prev) {
  if (source[i] !== '/') return null;
  if (source[i + 1] === '/') return { i: consumeLineComment(source, i, end, visit), prev };
  if (source[i + 1] === '*') {
    return { i: consumeBlockComment(source, i, end, visit, false), prev };
  }
  if (!REGEX_PREV.has(prev)) return null;
  const start = i;
  const next = scanRegexLiteral(source, i, end);
  visit('keep', source.slice(start, next), start);
  return { i: next, prev: 'ident' };
}

function walkTemplate(source, start, end, visit) {
  visit('keep', '`', start);
  let i = start + 1;
  while (i < end) {
    const ch = source[i];
    if (ch === '\\') {
      visit('keep', source.slice(i, Math.min(i + 2, end)), i);
      i += 2;
      continue;
    }
    if (ch === '`') {
      visit('keep', '`', i);
      return i + 1;
    }
    if (ch === '$' && source[i + 1] === '{') {
      visit('keep', '${', i);
      i = walkJsRange(source, i + 2, end, visit, { prev: 'start', stopAtBrace: true });
      if (i < end && source[i] === '}') {
        visit('keep', '}', i);
        i++;
      }
      continue;
    }
    visit('keep', ch, i);
    i++;
  }
  return i;
}

function walkJsRange(source, from, end, visit, opts) {
  let i = from;
  let prev = opts.prev ?? 'start';
  let braceDepth = 0;
  while (i < end) {
    const ch = source[i];
    if (opts.stopAtBrace && ch === '}' && braceDepth === 0) return i;
    const slash = consumeSlash(source, i, end, visit, prev);
    if (slash) {
      i = slash.i;
      prev = slash.prev;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const scanned = scanQuoted(source, i, ch);
      visit('keep', scanned.text, i);
      i = scanned.end;
      prev = 'ident';
      continue;
    }
    if (ch === '`') {
      i = walkTemplate(source, i, end, visit);
      prev = 'ident';
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const ident = consumeIdent(source, i, end, visit);
      i = ident.i;
      prev = ident.prev;
      continue;
    }
    if (opts.stopAtBrace && ch === '{') braceDepth++;
    if (opts.stopAtBrace && ch === '}') braceDepth--;
    visit('keep', ch, i);
    const classified = classifyPunct(ch);
    if (classified) prev = classified;
    i++;
  }
  return i;
}

function walkJs(source, _fileName, visit) {
  let from = 0;
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    const shebang = nl === -1 ? source : source.slice(0, nl);
    visit('keep', shebang, 0);
    from = shebang.length;
  }
  walkJsRange(source, from, source.length, visit, { prev: 'start', stopAtBrace: false });
}

function collectFromWalk(source, walk) {
  let out = '';
  const hits = [];
  walk(source, (kind, text, start) => {
    if (kind === 'drop') hits.push({ line: lineAt(source, start), text: firstLine(text) });
    out += kind === 'drop' ? blankNonNewlines(text) : text;
  });
  return { out, hits };
}

function stripJs(source, fileName = 'file.ts') {
  return collectFromWalk(source, (src, visit) => walkJs(src, fileName, visit)).out;
}

function findJs(source, fileName = 'file.ts') {
  return collectFromWalk(source, (src, visit) => walkJs(src, fileName, visit)).hits;
}

function consumeRawTicks(source, start, end, visit) {
  let i = start + 1;
  while (i < end && source[i] !== '`') i++;
  if (i < end) i++;
  visit('keep', source.slice(start, i), start);
  return i;
}

function walkCLike(source, visit, { nested = false, rawTicks = false, lineComments = true } = {}) {
  let i = 0;
  const end = source.length;
  while (i < end) {
    const ch = source[i];
    if (rawTicks && ch === '`') {
      i = consumeRawTicks(source, i, end, visit);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const scanned = scanQuoted(source, i, ch);
      visit('keep', scanned.text, i);
      i = scanned.end;
      continue;
    }
    if (lineComments && ch === '/' && source[i + 1] === '/') {
      i = consumeLineComment(source, i, end, visit);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = consumeBlockComment(source, i, end, visit, nested);
      continue;
    }
    visit('keep', ch, i);
    i++;
  }
}

function stripCLike(source, opts) {
  return collectFromWalk(source, (src, visit) => walkCLike(src, visit, opts)).out;
}

function findCLike(source, opts) {
  return collectFromWalk(source, (src, visit) => walkCLike(src, visit, opts)).hits;
}

function stripGo(source) {
  return stripCLike(source, { rawTicks: true });
}

function findGo(source) {
  return findCLike(source, { rawTicks: true });
}

function stripHash(source) {
  const lines = source.split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*#!/.test(line)) {
      out.push(line);
      continue;
    }
    out.push(stripHashLine(line));
  }
  return out.join('\n');
}

function stripHashLine(line) {
  let i = 0;
  let quote = null;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      const raw = line.slice(i);
      if (isKeptComment(raw)) return line;
      return line.slice(0, i).trimEnd();
    }
    i++;
  }
  return line;
}

function findHash(source) {
  const hits = [];
  const lines = source.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/^\s*#!/.test(line)) continue;
    const stripped = stripHashLine(line);
    if (stripped !== line) {
      const idx = line.indexOf('#');
      hits.push({ line: li + 1, text: firstLine(line.slice(idx)) });
    }
  }
  return hits;
}

function stripHtml(source) {
  return source.replace(/<!--([\s\S]*?)-->/g, (full) =>
    isKeptComment(full) ? full : blankNonNewlines(full)
  );
}

function findHtml(source) {
  const hits = [];
  const re = /<!--([\s\S]*?)-->/g;
  let match;
  while ((match = re.exec(source))) {
    if (!isKeptComment(match[0])) {
      hits.push({ line: lineAt(source, match.index), text: firstLine(match[0]) });
    }
  }
  return hits;
}

function stripCommentKeys(value) {
  if (Array.isArray(value)) return value.map(stripCommentKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '$comment') continue;
      out[key] = stripCommentKeys(child);
    }
    return out;
  }
  return value;
}

function stripJson(source) {
  const withoutComments = stripJs(source, 'file.jsonc');
  try {
    const parsed = JSON.parse(withoutComments);
    if (!jsonHasCommentKey(parsed)) return withoutComments;
    return `${JSON.stringify(stripCommentKeys(parsed), null, 2)}\n`;
  } catch {
    return withoutComments;
  }
}

function findJson(source) {
  const hits = findJs(source, 'file.jsonc');
  try {
    const parsed = JSON.parse(stripJs(source, 'file.jsonc'));
    if (jsonHasCommentKey(parsed)) {
      hits.push({ line: 1, text: '$comment' });
    }
  } catch {
    // JSONC that is not yet valid JSON after comment strip — comment hits stand.
  }
  return hits;
}

function jsonHasCommentKey(value) {
  if (Array.isArray(value)) return value.some(jsonHasCommentKey);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, child]) => key === '$comment' || jsonHasCommentKey(child)
    );
  }
  return false;
}

function stripSwift(source) {
  return stripCLike(source, { nested: true });
}

function findSwift(source) {
  return findCLike(source, { nested: true });
}

export function stripSource(source, language, fileName = 'file') {
  switch (language) {
    case 'js':
      return stripJs(source, fileName);
    case 'css':
      return stripCLike(source, { lineComments: false });
    case 'swift':
      return stripSwift(source);
    case 'go':
      return stripGo(source);
    case 'hash':
      return stripHash(source);
    case 'html':
      return stripHtml(source);
    case 'json':
      return stripJson(source);
    default:
      return source;
  }
}

export function findComments(source, language, fileName = 'file') {
  switch (language) {
    case 'js':
      return findJs(source, fileName);
    case 'css':
      return findCLike(source, { lineComments: false });
    case 'swift':
      return findSwift(source);
    case 'go':
      return findGo(source);
    case 'hash':
      return findHash(source);
    case 'html':
      return findHtml(source);
    case 'json':
      return findJson(source);
    default:
      return [];
  }
}
