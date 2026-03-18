/**
 * Message renderer — converts message content to HTML with
 * syntax-highlighted code blocks and full GFM markdown support via marked.
 *
 * Replaces the unified.js 7-plugin pipeline with a single marked.parse()
 * call + DOMPurify sanitization for faster streaming rendering (~60fps).
 */

import { Marked, type Tokens } from 'marked';
import { sanitize as purify } from 'isomorphic-dompurify';

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

  if (lang === 'shtml') return html; // preserve raw content for inline sprinkle hydration

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

// -- Marked instance with custom renderers --

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = lang ?? '';
      const highlighted = highlightCode(text, language);
      const langClass = language ? ` class="language-${escapeHtml(language)}"` : '';
      return `<pre><code${langClass}>${highlighted}</code></pre>\n`;
    },
    link({ href, title, tokens }: Tokens.Link): string {
      const url = href ?? '';
      if (url.startsWith('javascript:')) {
        return this.parser.parseInline(tokens);
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const text = this.parser.parseInline(tokens);
      return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

// -- DOMPurify configuration --

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'b', 'i', 'em', 'strong', 'p', 'br', 'code', 'pre',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'del', 'blockquote', 'hr', 'img', 'span', 'div',
    'details', 'summary', 'input',
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'class',
    'target', 'rel', 'type', 'checked', 'disabled',
  ],
  ALLOW_DATA_ATTR: false,
};

function sanitize(html: string): string {
  return purify(html, PURIFY_CONFIG) as string;
}

// Force target="_blank" on all links after sanitization (catches autolinks
// and any raw HTML <a> tags that DOMPurify let through).
function forceNewTabLinks(html: string): string {
  return html.replace(
    /<a\s([^>]*?)>/g,
    (_match, attrs: string) => {
      let result = attrs;
      // Ensure target="_blank" (replace existing or add new)
      if (/(^|\s)target\s*=/i.test(result)) {
        result = result.replace(
          /(^|\s)target\s*=\s*(['"])[^'"]*\2/gi,
          '$1target="_blank"',
        );
      } else {
        result += ' target="_blank"';
      }
      // Ensure rel="noopener noreferrer" (replace existing or add new)
      if (/(^|\s)rel\s*=/i.test(result)) {
        result = result.replace(
          /(^|\s)rel\s*=\s*(['"])[^'"]*\2/gi,
          '$1rel="noopener noreferrer"',
        );
      } else {
        result += ' rel="noopener noreferrer"';
      }
      return `<a ${result}>`;
    },
  );
}

// -- Public API (same exports as before) --

const SURFACED_ERROR_PARAGRAPH_RE = /<p><strong>Error:<\/strong>\s*([\s\S]*?)<\/p>/g;

function renderBaseMessageContent(content: string): string {
  const raw = marked.parse(content) as string;
  return forceNewTabLinks(sanitize(raw));
}

function renderSurfacedErrorBlocks(html: string): string {
  return html.replace(
    SURFACED_ERROR_PARAGRAPH_RE,
    (_match, body: string) => `<div class="msg__error" role="alert"><div class="msg__error-label">Error</div><div class="msg__error-body">${body}</div></div>`,
  );
}

/**
 * Render a message content string to HTML.
 * Uses marked with GFM for full GFM support:
 * tables, strikethrough, task lists, autolinks, and more.
 */
export function renderMessageContent(content: string): string {
  return renderBaseMessageContent(content);
}

/**
 * Render assistant message content, upgrading surfaced runtime/provider errors
 * into dedicated error blocks rather than normal prose paragraphs.
 */
export function renderAssistantMessageContent(content: string): string {
  return renderSurfacedErrorBlocks(renderBaseMessageContent(content));
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
