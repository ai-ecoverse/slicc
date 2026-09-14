import { escapeHtml } from '@slicc/webcomponents/internal/html';
import { sanitize as purify } from 'isomorphic-dompurify';
import { Marked, type Tokens } from 'marked';
import { resolveMessageMedia } from '../base/message-media.js';
import { stripReplyLangMarker } from '../speech/dictation-priming.js';
import { highlightCode } from './code-highlight.js';

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

      const media = resolveMessageMedia(url);
      if (media?.kind === 'video' || media?.kind === 'audio') {
        const labelAttr = text ? ` aria-label="${escapeHtml(text)}"` : '';
        const tag = media.kind === 'video' ? 'video' : 'audio';
        return (
          `<${tag} class="msg__media msg__media--${tag}" src="${escapeHtml(media.src)}"` +
          `${labelAttr}${titleAttr} controls preload="metadata" playsinline></${tag}>`
        );
      }

      const src = media ? media.src : url;
      const classAttr = media ? ' class="msg__media msg__media--image"' : '';
      return `<img${classAttr} src="${escapeHtml(src)}"${altAttr}${titleAttr}>`;
    },
  },
});

const RAW_MEDIA_SRC_RE = /(<(?:img|video|audio|source)\b[^>]*?\ssrc=")(\/[^"]*)(")/gi;

export function resolveRawMediaSrc(html: string): string {
  return html.replace(RAW_MEDIA_SRC_RE, (match, prefix: string, src: string, suffix: string) => {
    const media = resolveMessageMedia(src);
    return media ? `${prefix}${escapeHtml(media.src)}${suffix}` : match;
  });
}

const MEDIA_ONLY_PARAGRAPH_RE =
  /<p>((?:\s|<br\s*\/?>|<img class="msg__media[^>]*>|<video class="msg__media[^>]*><\/video>|<audio class="msg__media[^>]*><\/audio>)+)<\/p>/g;

const MEDIA_ELEMENT_RE = /<(?:img|video|audio) class="msg__media[^>]*>(?:<\/(?:video|audio)>)?/g;

export function groupMediaGalleries(html: string): string {
  return html.replace(MEDIA_ONLY_PARAGRAPH_RE, (match, inner: string) => {
    const items = inner.match(MEDIA_ELEMENT_RE) ?? [];
    if (items.length < 2) return match;

    const sizing =
      items.length === 2
        ? ' msg__media-gallery--pair'
        : items.length === 4
          ? ' msg__media-gallery--quad'
          : '';
    return `<div class="msg__media-gallery${sizing}">${items.join('')}</div>`;
  });
}

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

function forceNewTabLinks(html: string): string {
  return html.replace(/<a\s([^>]*?)>/g, (_match, attrs: string) => {
    let result = attrs;

    if (/(^|\s)target\s*=/i.test(result)) {
      result = result.replace(/(^|\s)target\s*=\s*(['"])[^'"]*\2/gi, '$1target="_blank"');
    } else {
      result += ' target="_blank"';
    }

    if (/(^|\s)rel\s*=/i.test(result)) {
      result = result.replace(/(^|\s)rel\s*=\s*(['"])[^'"]*\2/gi, '$1rel="noopener noreferrer"');
    } else {
      result += ' rel="noopener noreferrer"';
    }
    return `<a ${result}>`;
  });
}

const SURFACED_ERROR_PARAGRAPH_RE = /<p><strong>Error:<\/strong>\s*([\s\S]*?)<\/p>/g;

const SHTML_CODE_BLOCK_RE = /<pre><code class="language-shtml">[\s\S]*?<\/code><\/pre>/g;

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

function replaceShtmlWithDipPlaceholder(html: string): string {
  return html.replace(SHTML_CODE_BLOCK_RE, DIP_PENDING_PLACEHOLDER);
}

export function renderMessageContent(content: string): string {
  return renderBaseMessageContent(content);
}

export function renderAssistantMessageContent(content: string, isStreaming = false): string {
  let html = renderSurfacedErrorBlocks(renderBaseMessageContent(stripReplyLangMarker(content)));
  if (isStreaming) html = replaceShtmlWithDipPlaceholder(html);
  return html;
}

export function renderToolInput(input: unknown): string {
  if (typeof input === 'string') return escapeHtml(input);
  try {
    return escapeHtml(JSON.stringify(input, null, 2));
  } catch {
    return escapeHtml(String(input));
  }
}
