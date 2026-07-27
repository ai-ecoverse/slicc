const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function decodeEntity(entity: string): string {
  const body = entity.slice(1, -1);
  if (!body.startsWith('#')) return NAMED_ENTITIES[body.toLowerCase()] ?? entity;

  const hexadecimal = body[1]?.toLowerCase() === 'x';
  const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
  if (
    !Number.isFinite(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

/** Convert the HTML emitted by Biome's `printDiagnostics()` to shell-safe plain text. */
export function htmlDiagnosticsToText(html: string): string {
  let text = '';
  let cursor = 0;
  let trailingStructuralBreak = false;
  const tags = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>/g;

  for (const match of html.matchAll(tags)) {
    const content = html.slice(cursor, match.index);
    if (content) {
      text += content;
      trailingStructuralBreak = false;
    }

    const tag = match[0];
    const tagName = /^<\/?\s*([A-Za-z0-9-]+)/.exec(tag)?.[1]?.toLowerCase();
    if (tagName === 'br') {
      text += '\n';
      trailingStructuralBreak = false;
    } else if (tagName && BLOCK_ELEMENTS.has(tagName) && text.length > 0 && !text.endsWith('\n')) {
      text += '\n';
      trailingStructuralBreak = true;
    }
    cursor = (match.index ?? 0) + tag.length;
  }

  const tail = html.slice(cursor);
  if (tail) {
    text += tail;
    trailingStructuralBreak = false;
  }
  if (trailingStructuralBreak) text = text.slice(0, -1);

  return text.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|#(?:[0-9]+|[xX][0-9A-Fa-f]+));/gi,
    decodeEntity
  );
}
