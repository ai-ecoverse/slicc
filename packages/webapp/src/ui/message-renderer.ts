/**
 * Message renderer — converts message content to HTML with
 * syntax-highlighted code blocks and full GFM markdown support via marked.
 *
 * Replaces the unified.js 7-plugin pipeline with a single marked.parse()
 * call + DOMPurify sanitization for faster streaming rendering (~60fps).
 */

import { escapeHtml } from '@slicc/webcomponents/internal/html';
import { sanitize as purify } from 'isomorphic-dompurify';
import { Marked, type Tokens } from 'marked';
import { resolveMessageMedia } from '../base/message-media.js';
import { stripReplyLangMarker } from '../speech/dictation-priming.js';

/**
 * Simple syntax highlighter for code blocks.
 * Supports JS/TS-style keyword, string, number, comment highlighting.
 */
function highlightCode(code: string, lang: string): string {
  let html = escapeHtml(code);

  if (lang === 'shtml') return html; // preserve raw content for dip hydration

  if (['js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx'].includes(lang)) {
    html = highlightJS(html);
  } else if (lang === 'json') {
    html = highlightJSON(html);
  } else if (['bash', 'sh', 'shell', 'zsh'].includes(lang)) {
    html = highlightBash(html);
  }

  return html;
}

function protectHighlightedSpans(html: string): {
  html: string;
  restore: (input: string) => string;
} {
  const protectedSpans: string[] = [];
  const protectedHtml = html.replace(
    /<span class="tok-(?:comment|string)">[\s\S]*?<\/span>/g,
    (match) => {
      const token = String.fromCharCode(0xe000 + protectedSpans.length);
      protectedSpans.push(match);
      return token;
    }
  );

  return {
    html: protectedHtml,
    restore: (input: string) =>
      input.replace(/[\ue000-\uf8ff]/g, (token) => {
        const index = token.charCodeAt(0) - 0xe000;
        return protectedSpans[index] ?? token;
      }),
  };
}

function highlightJS(html: string): string {
  html = html.replace(/(\/\/[^\n]*)/g, '<span class="tok-comment">$1</span>');
  html = html.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-comment">$1</span>');
  html = html.replace(
    /(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g,
    '<span class="tok-string">$1</span>'
  );
  const protectedSpans = protectHighlightedSpans(html);
  html = protectedSpans.html;
  const kw = [
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
  html = html.replace(
    new RegExp(`\\b(${kw.join('|')})\\b`, 'g'),
    '<span class="tok-keyword">$1</span>'
  );
  html = html.replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-number">$1</span>');
  html = html.replace(/\b([a-zA-Z_$][\w$]*)\s*(?=\()/g, '<span class="tok-fn">$1</span>');
  return protectedSpans.restore(html);
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
    /(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g,
    '<span class="tok-string">$1</span>'
  );
  const kw = [
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
  html = html.replace(
    new RegExp(`\\b(${kw.join('|')})\\b`, 'g'),
    '<span class="tok-keyword">$1</span>'
  );
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
    image({ href, title, text }: Tokens.Image): string {
      const url = href ?? '';
      const altAttr = text ? ` alt="${escapeHtml(text)}"` : '';
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      // One markdown syntax, two elements: `resolveMessageMedia` rewrites VFS
      // paths to `/preview/*` (a bare `/shared/x.png` would otherwise hit the
      // SPA fallback and silently decode HTML as an image) and decides whether
      // the file is a picture or a clip.
      const media = resolveMessageMedia(url);
      if (media?.kind === 'video' || media?.kind === 'audio') {
        // The alt text becomes an `aria-label`: `alt` is inert on <video> and
        // <audio>, so carrying it over would silently drop the only
        // description the author wrote. `preload="metadata"` so a gallery of
        // clips costs first frames rather than whole files; `playsinline`
        // keeps iOS from hijacking video into fullscreen (inert on audio).
        const labelAttr = text ? ` aria-label="${escapeHtml(text)}"` : '';
        const tag = media.kind === 'video' ? 'video' : 'audio';
        return (
          `<${tag} class="msg__media msg__media--${tag}" src="${escapeHtml(media.src)}"` +
          `${labelAttr}${titleAttr} controls preload="metadata" playsinline></${tag}>`
        );
      }
      // .shtml image references render as dip iframes during hydration, so they
      // come back from resolveMessageMedia() untouched: hydrateDips() detects
      // img[src$=".shtml"] and replaces it with a sandboxed iframe. Everything
      // else is an <img>, pointed at the resolved src.
      const src = media ? media.src : url;
      const classAttr = media ? ' class="msg__media msg__media--image"' : '';
      return `<img${classAttr} src="${escapeHtml(src)}"${altAttr}${titleAttr}>`;
    },
  },
});

/**
 * `src="/…"` on a media element in RAW HTML — the escape hatch an agent reaches
 * for when markdown cannot express the layout (a two-column table of frames,
 * a `<video poster>`).
 */
const RAW_MEDIA_SRC_RE = /(<(?:img|video|audio|source)\b[^>]*?\ssrc=")(\/[^"]*)(")/gi;

/**
 * Give raw-HTML media the same VFS resolution the markdown `image()` token
 * gets, so `<img src="/shared/a.png">` is not a silent failure while
 * `![a](/shared/a.png)` works. Without this the two spellings disagree, and the
 * broken one fails invisibly — the SPA fallback answers 200 + `text/html`
 * rather than 404.
 *
 * Runs on marked's output before sanitization. Only rooted paths match, so
 * markdown-emitted media (already absolute `http(s)://…/preview/…` URLs) and
 * remote URLs are both left alone; `.shtml` is skipped because `hydrateDips()`
 * needs that src verbatim.
 */
export function resolveRawMediaSrc(html: string): string {
  return html.replace(RAW_MEDIA_SRC_RE, (match, prefix: string, src: string, suffix: string) => {
    const media = resolveMessageMedia(src);
    return media ? `${prefix}${escapeHtml(media.src)}${suffix}` : match;
  });
}

/**
 * A paragraph whose entire content is media — the shape marked produces for
 * `![a](x.png) ![b](y.png)` on one line, or on consecutive lines under
 * `breaks: true` (which interleaves `<br>`). Anchored on the `msg__media`
 * class the `image()` renderer stamps, so a hand-written `<img>` in raw HTML
 * and a `.shtml` dip reference (which never gets the class) are both ignored.
 */
const MEDIA_ONLY_PARAGRAPH_RE =
  /<p>((?:\s|<br\s*\/?>|<img class="msg__media[^>]*>|<video class="msg__media[^>]*><\/video>|<audio class="msg__media[^>]*><\/audio>)+)<\/p>/g;

/** Individual media elements inside such a paragraph. */
const MEDIA_ELEMENT_RE = /<(?:img|video|audio) class="msg__media[^>]*>(?:<\/(?:video|audio)>)?/g;

/**
 * Lay a run of two or more adjacent images/videos out as a gallery grid.
 *
 * Agents routinely emit several frames at once ("here are the four candidate
 * thumbnails"). Stacked full-width they push the rest of the reply off screen,
 * so a paragraph that is *nothing but* media becomes a grid instead. A lone
 * image is left as a normal paragraph — a grid of one is just an image with
 * extra rules.
 *
 * Runs before sanitization so DOMPurify still validates the result; `div` and
 * `class` are already in the allowlist, so no new surface is introduced.
 */
export function groupMediaGalleries(html: string): string {
  return html.replace(MEDIA_ONLY_PARAGRAPH_RE, (match, inner: string) => {
    const items = inner.match(MEDIA_ELEMENT_RE) ?? [];
    if (items.length < 2) return match;
    // `data-count` is unavailable (ALLOW_DATA_ATTR is false), so the item
    // count rides on a modifier class the stylesheet can select on. Two and
    // four both want an explicit two-column grid — left to `auto-fit`, four
    // items land as an unbalanced 3 + 1.
    const sizing =
      items.length === 2
        ? ' msg__media-gallery--pair'
        : items.length === 4
          ? ' msg__media-gallery--quad'
          : '';
    return `<div class="msg__media-gallery${sizing}">${items.join('')}</div>`;
  });
}

// -- DOMPurify configuration --

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'a',
    'b',
    'i',
    'em',
    'strong',
    'p',
    'br',
    'code',
    'pre',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'del',
    'blockquote',
    'hr',
    'img',
    'span',
    'div',
    'details',
    'summary',
    'input',
    // Media emitted by the `image()` renderer above. Without `video` here
    // DOMPurify deletes the element outright and the clip vanishes silently.
    'video',
    'audio',
    'source',
  ],
  ALLOWED_ATTR: [
    'href',
    'src',
    'alt',
    'title',
    'class',
    'target',
    'rel',
    'type',
    'checked',
    'disabled',
    // Media playback attributes. Omitting `controls` would render a video
    // with no way to play it.
    'controls',
    'preload',
    'playsinline',
    'poster',
    'loop',
    'muted',
    'width',
    'height',
  ],
  ALLOW_DATA_ATTR: false,
};

function sanitize(html: string): string {
  return purify(html, PURIFY_CONFIG) as string;
}

// Force target="_blank" on all links after sanitization (catches autolinks
// and any raw HTML <a> tags that DOMPurify let through).
function forceNewTabLinks(html: string): string {
  return html.replace(/<a\s([^>]*?)>/g, (_match, attrs: string) => {
    let result = attrs;
    // Ensure target="_blank" (replace existing or add new)
    if (/(^|\s)target\s*=/i.test(result)) {
      result = result.replace(/(^|\s)target\s*=\s*(['"])[^'"]*\2/gi, '$1target="_blank"');
    } else {
      result += ' target="_blank"';
    }
    // Ensure rel="noopener noreferrer" (replace existing or add new)
    if (/(^|\s)rel\s*=/i.test(result)) {
      result = result.replace(/(^|\s)rel\s*=\s*(['"])[^'"]*\2/gi, '$1rel="noopener noreferrer"');
    } else {
      result += ' rel="noopener noreferrer"';
    }
    return `<a ${result}>`;
  });
}

// -- Public API (same exports as before) --

const SURFACED_ERROR_PARAGRAPH_RE = /<p><strong>Error:<\/strong>\s*([\s\S]*?)<\/p>/g;

// Match a fenced shtml code block as emitted by the marked renderer above.
// Used to swap raw shtml in for a "pending" placeholder while streaming, so
// users see a loading hint instead of the markup typing out — the closing
// fence may not have arrived yet, but marked still wraps the partial content
// in <pre><code class="language-shtml">…</code></pre>.
const SHTML_CODE_BLOCK_RE = /<pre><code class="language-shtml">[\s\S]*?<\/code><\/pre>/g;

// Mirrors the tool-call row layout (label on the left, pulsing status circle
// pinned to the right) so the placeholder reads as another in-progress step
// rather than a separate widget. Reuses the `tool-status-pulse` keyframe and
// the same orange used by `.tool-call--running`.
const DIP_PENDING_PLACEHOLDER =
  '<div class="msg__dip-pending" role="status" aria-live="polite" aria-label="Pouring a dip">' +
  '<span class="msg__dip-pending-label">Pouring a dip…</span>' +
  '<span class="msg__dip-pending-status" aria-hidden="true"></span>' +
  '</div>';

function renderBaseMessageContent(content: string): string {
  const raw = marked.parse(content) as string;
  return forceNewTabLinks(sanitize(groupMediaGalleries(resolveRawMediaSrc(raw))));
}

function renderSurfacedErrorBlocks(html: string): string {
  return html.replace(
    SURFACED_ERROR_PARAGRAPH_RE,
    (_match, body: string) =>
      `<div class="msg__error" role="alert"><div class="msg__error-label">Error</div><div class="msg__error-body">${body}</div></div>`
  );
}

/**
 * While the assistant streams a fenced ```shtml block, replace the raw
 * markup with a placeholder card. Hydration into a real dip iframe still
 * happens later (after the stream ends) via `hydrateDips()`, which keys off
 * the `pre > code.language-shtml` shape — so this swap MUST be skipped on
 * the final render, otherwise the code blocks disappear before hydration.
 */
function replaceShtmlWithDipPlaceholder(html: string): string {
  return html.replace(SHTML_CODE_BLOCK_RE, DIP_PENDING_PLACEHOLDER);
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
 * into dedicated error blocks rather than normal prose paragraphs. When
 * `isStreaming` is true, in-progress shtml fenced blocks are swapped for a
 * "pouring a dip" placeholder so users see a loading hint instead of the
 * raw HTML typing out. On the final render `isStreaming` must be false so
 * the shtml code blocks survive for `hydrateDips()` to mount as iframes.
 */
export function renderAssistantMessageContent(content: string, isStreaming = false): string {
  // Drop the hidden <!--lang:xx--> reply-language marker (used only to pick a
  // TTS voice) so it never reaches the rendered bubble.
  let html = renderSurfacedErrorBlocks(renderBaseMessageContent(stripReplyLangMarker(content)));
  if (isStreaming) html = replaceShtmlWithDipPlaceholder(html);
  return html;
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
