/**
 * Message renderer — converts message content to HTML with
 * syntax-highlighted code blocks and full GFM markdown support via unified.js.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import type { Code } from 'mdast';
import type { Element } from 'hast';

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
  return {
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [{
      type: 'element',
      tagName: 'code',
      properties: lang ? { className: [`language-${lang}`] } : {},
      children: [{ type: 'raw' as 'text', value: highlighted } as never],
    }],
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true, handlers: { code: codeHandler } })
  .use(rehypeStringify, { allowDangerousHtml: true });

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
