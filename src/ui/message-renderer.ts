/**
 * Message renderer — converts message content to HTML with
 * syntax-highlighted code blocks and full GFM markdown support via unified.js.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Schema } from 'hast-util-sanitize';
import rehypeStringify from 'rehype-stringify';
import type { Code } from 'mdast';
import type { Element } from 'hast';

/** Minimal raw-HTML node type used by rehype-raw / hast-util-raw. */
interface RawNode {
  type: 'raw';
  value: string;
}

/** Escape HTML special characters. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Simple syntax highlighter for code blocks.
 * Supports JS/TS-style keyword, string, number, comment highlighting.
 */
function highlightCode(code: string, lang: string): string {
  let html = escapeHtml(code);

  if (['js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx'].includes(lang)) {
    html = highlightJS(html);
  } else if (lang === 'json') {
    html = highlightJSON(html);
  } else if (['bash', 'sh', 'shell', 'zsh'].includes(lang)) {
    html = highlightBash(html);
  }

  return html;
}

function highlightJS(html: string): string {
  html = html.replace(/(\/\/[^\n]*)/g, '<span class="tok-comment">$1</span>');
  html = html.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-comment">$1</span>');
  html = html.replace(
    /(&quot;[^&]*?&quot;|&#x27;[^&]*?&#x27;|`[^`]*?`)/g,
    '<span class="tok-string">$1</span>',
  );
  const kw = [
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
    'class', 'extends', 'import', 'export', 'from', 'default', 'new', 'this',
    'async', 'await', 'try', 'catch', 'throw', 'typeof', 'instanceof',
    'interface', 'type', 'enum', 'implements', 'abstract', 'public', 'private',
    'protected', 'readonly', 'static', 'void', 'null', 'undefined', 'true', 'false',
  ];
  html = html.replace(new RegExp(`\\b(${kw.join('|')})\\b`, 'g'), '<span class="tok-keyword">$1</span>');
  html = html.replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-number">$1</span>');
  html = html.replace(/\b([a-zA-Z_$][\w$]*)\s*(?=\()/g, '<span class="tok-fn">$1</span>');
  return html;
}

function highlightJSON(html: string): string {
  html = html.replace(/(&quot;[^&]*?&quot;)\s*:/g, '<span class="tok-keyword">$1</span>:');
  html = html.replace(/:\s*(&quot;[^&]*?&quot;)/g, ': <span class="tok-string">$1</span>');
  html = html.replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-number">$1</span>');
  html = html.replace(/\b(true|false|null)\b/g, '<span class="tok-keyword">$1</span>');
  return html;
}

function highlightBash(html: string): string {
  html = html.replace(/(#[^\n]*)/g, '<span class="tok-comment">$1</span>');
  html = html.replace(
    /(&quot;[^&]*?&quot;|&#x27;[^&]*?&#x27;)/g,
    '<span class="tok-string">$1</span>',
  );
  const kw = ['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'echo', 'export', 'cd', 'ls', 'mkdir', 'rm', 'cp', 'mv', 'cat', 'grep', 'npm', 'node', 'git'];
  html = html.replace(new RegExp(`\\b(${kw.join('|')})\\b`, 'g'), '<span class="tok-keyword">$1</span>');
  return html;
}

/** remark-rehype handler for fenced code blocks — applies tok-* syntax highlighting. */
function codeHandler(_state: unknown, node: Code): Element {
  const lang = node.lang ?? '';
  const highlighted = highlightCode(node.value, lang);
  const rawNode: RawNode = { type: 'raw', value: highlighted };
  return {
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [{
      type: 'element',
      tagName: 'code',
      properties: lang ? { className: [`language-${lang}`] } : {},
      children: [rawNode as unknown as Element],
    }],
  };
}

function ensureSafeLinkRel(rel: unknown): string {
  const tokens = new Set<string>();

  if (typeof rel === 'string') {
    for (const token of rel.split(/\s+/)) {
      if (token) tokens.add(token);
    }
  } else if (Array.isArray(rel)) {
    for (const value of rel) {
      if (typeof value !== 'string') continue;
      for (const token of value.split(/\s+/)) {
        if (token) tokens.add(token);
      }
    }
  }

  tokens.add('noopener');
  tokens.add('noreferrer');

  return Array.from(tokens).join(' ');
}

function addNewTabToLinks() {
  return (tree: unknown) => {
    visitNode(tree);
  };
}

function visitNode(node: unknown): void {
  if (!node || typeof node !== 'object') return;

  const hastNode = node as {
    type?: string;
    tagName?: string;
    properties?: Record<string, unknown>;
    children?: unknown[];
  };

  if (hastNode.type === 'element' && hastNode.tagName === 'a' && hastNode.properties?.href) {
    hastNode.properties = {
      ...hastNode.properties,
      target: '_blank',
      rel: ensureSafeLinkRel(hastNode.properties.rel),
    };
  }

  if (Array.isArray(hastNode.children)) {
    for (const child of hastNode.children) {
      visitNode(child);
    }
  }
}

/**
 * Sanitize schema: extends the default (safe HTML subset) to also allow
 * - `span` with `class` — for tok-* syntax-highlighting spans
 * - `class` on `code` — for language-* identifiers
 */
const sanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: ['className'],
    code: [['className', /^language-/]],
  },
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkRehype, { allowDangerousHtml: true, handlers: { code: codeHandler } })
  .use(rehypeRaw)                          // parse raw nodes (incl. our tok-* spans) into hast
  .use(rehypeSanitize, sanitizeSchema)     // strip XSS vectors, keep safe subset + tok-* spans
  .use(addNewTabToLinks)                   // force safe new-tab behavior for rendered message links
  .use(rehypeStringify);

/**
 * Render a message content string to HTML.
 * Uses unified.js with remark-gfm for full GFM support:
 * tables, strikethrough, task lists, autolinks, and more.
 */
export function renderMessageContent(content: string): string {
  return String(processor.processSync(content));
}

/**
 * Render a tool call's input as a formatted string.
 */
export function renderToolInput(input: unknown): string {
  if (typeof input === 'string') return escapeHtml(input);
  try {
    return escapeHtml(JSON.stringify(input, null, 2));
  } catch {
    return escapeHtml(String(input));
  }
}
