/**
 * RFC 8288 Web Linking — `Link` header parser and builder.
 *
 * Pure module, no I/O. Used by:
 *  - the CDP navigation watcher (CLI/Electron) to extract handoff/upskill links
 *    from main-frame document responses
 *  - the chrome.webRequest observer (extension) to do the same
 *  - the playwright-cli / curl wrappers for generic discovery
 *
 * The parser handles:
 *  - comma-separated link-values, with commas inside quoted-strings preserved
 *  - multiple `Link:` header instances merged per RFC 7230
 *  - `param=token`, `param="quoted"` (with backslash escapes), and
 *    `param*=ext-value` forms (RFC 8187, UTF-8 charset only)
 *  - the "rel" parameter as a space-separated list of relation types
 *  - anchor and target URI resolution against an optional base URL
 *
 * The builder produces a single header value from a list of links and is the
 * inverse of the parser for the subset of inputs SLICC produces (no exotic
 * parameter names, RFC 8187 used only when a value contains non-ASCII).
 */

export interface ParsedLink {
  /** Resolved absolute URL of the link target (or the raw URI-reference if no base). */
  href: string;
  /** Relation type tokens parsed from the `rel` parameter. */
  rel: string[];
  /** Resolved absolute URL of the context (`anchor` parameter), if present. */
  anchor?: string;
  /** Media type of the target representation, if declared. */
  type?: string;
  /** Title of the target, RFC 8187-decoded if it was provided as `title*`. */
  title?: string;
  /** Language of the target, if declared. */
  hreflang?: string;
  /** All parameters seen on this link-value, lowercased keys. RFC 8187 ext-values are decoded. */
  params: Record<string, string>;
}

export interface LinkInput {
  /** Target URI-reference. Will be wrapped in `<>`. */
  href: string;
  /** One or more relation types. URI rels are quoted as a single token-list value. */
  rel: string[] | string;
  type?: string;
  title?: string;
  hreflang?: string;
  anchor?: string;
  /** Additional parameters; values are quoted if they contain non-token chars. */
  params?: Record<string, string>;
  /** Force `param*=UTF-8''…` encoding for the named parameters (e.g. `['title']`). */
  extEncode?: string[];
}

/* ───────────────────────────── parser ───────────────────────────── */

export function parseLinkHeader(
  input: string | string[] | null | undefined,
  baseUrl?: string
): ParsedLink[] {
  if (input == null) return [];
  // CDP joins multi-value headers with `\n`; treat it the same as separate
  // header instances. Normalize for both shapes — array elements may also
  // contain `\n`-joined values when callers preserve CDP's raw bag verbatim.
  let headerString: string;
  if (Array.isArray(input)) {
    headerString = input.join(', ').replace(/\n/g, ', ');
  } else if (typeof input === 'string') {
    headerString = input.replace(/\n/g, ', ');
  } else {
    return [];
  }
  if (headerString.length === 0) return [];

  const out: ParsedLink[] = [];
  const len = headerString.length;
  let i = 0;

  while (i < len) {
    i = skipOWS(headerString, i);
    if (i >= len) break;

    if (headerString[i] !== '<') {
      i = skipToNextValue(headerString, i);
      continue;
    }

    const uriEnd = headerString.indexOf('>', i + 1);
    if (uriEnd === -1) break;
    const rawUri = headerString.slice(i + 1, uriEnd);
    i = uriEnd + 1;

    const rawParams: Array<[string, string]> = [];
    while (i < len) {
      i = skipOWS(headerString, i);
      if (i >= len) break;
      if (headerString[i] === ',') {
        i++;
        break;
      }
      if (headerString[i] !== ';') {
        i = skipToNextValue(headerString, i);
        break;
      }
      i++;
      i = skipOWS(headerString, i);

      const nameStart = i;
      while (i < len && isTokenChar(headerString.charCodeAt(i))) i++;
      // `param*` — the trailing star is not a tchar but a recognised suffix.
      if (i < len && headerString[i] === '*') i++;
      if (nameStart === i) {
        i = skipToNextValue(headerString, i);
        break;
      }
      const name = headerString.slice(nameStart, i).toLowerCase();

      i = skipOWS(headerString, i);
      let value = '';
      if (i < len && headerString[i] === '=') {
        i++;
        i = skipOWS(headerString, i);
        if (i < len && headerString[i] === '"') {
          const r = readQuotedString(headerString, i);
          value = r.value;
          i = r.end;
        } else {
          const start = i;
          while (
            i < len &&
            headerString[i] !== ';' &&
            headerString[i] !== ',' &&
            !isOWSChar(headerString[i])
          )
            i++;
          value = headerString.slice(start, i);
        }
      }
      rawParams.push([name, value]);
    }

    const link = buildLink(rawUri, rawParams, baseUrl);
    if (link) out.push(link);
  }

  return out;
}

function skipOWS(s: string, i: number): number {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}
function isOWSChar(c: string): boolean {
  return c === ' ' || c === '\t';
}
function skipToNextValue(s: string, i: number): number {
  let inQuote = false;
  while (i < s.length) {
    const c = s[i];
    if (inQuote) {
      if (c === '\\' && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (c === '"') inQuote = false;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') return i + 1;
    }
    i++;
  }
  return i;
}
function readQuotedString(s: string, i: number): { value: string; end: number } {
  // s[i] === '"'
  i++;
  let result = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i++;
      if (i < s.length) {
        result += s[i];
        i++;
      }
    } else if (c === '"') {
      return { value: result, end: i + 1 };
    } else {
      result += c;
      i++;
    }
  }
  return { value: result, end: i };
}
function isTokenChar(code: number): boolean {
  // RFC 7230 tchar
  if (code >= 0x30 && code <= 0x39) return true; // 0-9
  if (code >= 0x41 && code <= 0x5a) return true; // A-Z
  if (code >= 0x61 && code <= 0x7a) return true; // a-z
  switch (code) {
    case 0x21: // !
    case 0x23: // #
    case 0x24: // $
    case 0x25: // %
    case 0x26: // &
    case 0x27: // '
    case 0x2a: // *
    case 0x2b: // +
    case 0x2d: // -
    case 0x2e: // .
    case 0x5e: // ^
    case 0x5f: // _
    case 0x60: // `
    case 0x7c: // |
    case 0x7e: // ~
      return true;
  }
  return false;
}

function buildLink(
  rawUri: string,
  rawParams: Array<[string, string]>,
  baseUrl?: string
): ParsedLink | null {
  const params: Record<string, string> = {};
  const extOverrides: Record<string, string> = {};

  for (const [name, value] of rawParams) {
    if (name.endsWith('*')) {
      const decoded = decodeExtValue(value);
      if (decoded != null) extOverrides[name.slice(0, -1)] = decoded;
      continue;
    }
    // RFC 8288: rel MUST NOT appear more than once; ignore later occurrences.
    if (name === 'rel' && 'rel' in params) continue;
    params[name] = value;
  }
  // RFC 8187 §4.3: ext value takes precedence over the regular value.
  for (const [name, value] of Object.entries(extOverrides)) {
    params[name] = value;
  }

  const href = resolveURI(rawUri, baseUrl);
  const anchor = params.anchor != null ? resolveURI(params.anchor, baseUrl) : undefined;

  const relRaw = params.rel ?? '';
  const rel = relRaw.split(/[ \t]+/).filter((s) => s.length > 0);

  const link: ParsedLink = { href, rel, params };
  if (anchor != null) link.anchor = anchor;
  if (params.type != null) link.type = params.type;
  if (params.title != null) link.title = params.title;
  if (params.hreflang != null) link.hreflang = params.hreflang;
  return link;
}

function resolveURI(ref: string, baseUrl?: string): string {
  if (!baseUrl) return ref;
  try {
    return new URL(ref, baseUrl).toString();
  } catch {
    return ref;
  }
}

/**
 * Decode an RFC 8187 ext-value: `charset "'" [language] "'" value-chars`.
 * Only UTF-8 is required by the RFC; other charsets return null (caller
 * keeps the regular parameter, if any).
 */
export function decodeExtValue(value: string): string | null {
  const firstQuote = value.indexOf("'");
  if (firstQuote === -1) return null;
  const secondQuote = value.indexOf("'", firstQuote + 1);
  if (secondQuote === -1) return null;
  const charset = value.slice(0, firstQuote).toLowerCase();
  if (charset !== 'utf-8') return null;
  try {
    return decodeURIComponent(value.slice(secondQuote + 1));
  } catch {
    return null;
  }
}

/* ───────────────────────────── builder ───────────────────────────── */

/**
 * Format a single link as one RFC 8288 link-value. Caller joins multiple
 * link-values with ", " (ASCII comma + SP) to form a complete header.
 *
 * Parameter values containing non-token characters are quoted. For
 * non-Latin1 values (or values listed in `extEncode`), an RFC 8187
 * `param*=UTF-8''…` form is emitted instead. CR/LF in parameter values
 * is always percent-encoded so a malicious instruction can never break
 * out of the header.
 */
export function formatLink(link: LinkInput): string {
  const rels = Array.isArray(link.rel) ? link.rel : [link.rel];
  const relValue = rels.join(' ');

  const ext = new Set(link.extEncode ?? []);

  const parts: string[] = [`<${link.href}>`];

  // rel goes first by convention (improves human readability).
  parts.push(`rel=${formatParamValue(relValue)}`);

  appendParam(parts, 'type', link.type, ext.has('type'));
  appendParam(parts, 'title', link.title, ext.has('title'));
  appendParam(parts, 'hreflang', link.hreflang, ext.has('hreflang'));
  appendParam(parts, 'anchor', link.anchor, ext.has('anchor'));

  if (link.params) {
    for (const [name, value] of Object.entries(link.params)) {
      if (
        name === 'rel' ||
        name === 'type' ||
        name === 'title' ||
        name === 'hreflang' ||
        name === 'anchor'
      )
        continue;
      appendParam(parts, name, value, ext.has(name));
    }
  }

  return parts.join('; ');
}

export function formatLinkHeader(links: LinkInput[]): string {
  return links.map(formatLink).join(', ');
}

function appendParam(
  parts: string[],
  name: string,
  value: string | undefined,
  forceExt: boolean
): void {
  if (value == null) return;
  const useExt = forceExt || needsExtEncoding(value);
  if (useExt) {
    // RFC 8187: percent-encode non-attr-chars; UTF-8 charset only.
    parts.push(`${name}*=UTF-8''${encodeRFC8187(value)}`);
  } else {
    parts.push(`${name}=${formatParamValue(value)}`);
  }
}

function needsExtEncoding(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Non-Latin1, control chars, or CR/LF — must use RFC 8187.
    if (code > 0xff || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function formatParamValue(value: string): string {
  // Token (no quoting) if every char is a tchar, else quoted-string.
  let needsQuote = value.length === 0;
  if (!needsQuote) {
    for (let i = 0; i < value.length; i++) {
      if (!isTokenChar(value.charCodeAt(i))) {
        needsQuote = true;
        break;
      }
    }
  }
  if (!needsQuote) return value;
  // Escape backslash, double-quote; encode CR/LF defensively even though
  // they are technically allowed inside quoted-string when surrounded by
  // OWS — many HTTP intermediaries reject them.
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    const code = value.charCodeAt(i);
    if (c === '\\' || c === '"') {
      out += '\\' + c;
    } else if (code === 0x0d) {
      out += '%0D';
    } else if (code === 0x0a) {
      out += '%0A';
    } else {
      out += c;
    }
  }
  out += '"';
  return out;
}

function encodeRFC8187(value: string): string {
  // attr-char per RFC 8187: ALPHA / DIGIT / "!" "#" "$" "&" "+" "-" "." "^" "_" "`" "|" "~"
  const bytes = new TextEncoder().encode(value);
  let out = '';
  for (const byte of bytes) {
    if (
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      byte === 0x21 || // !
      byte === 0x23 || // #
      byte === 0x24 || // $
      byte === 0x26 || // &
      byte === 0x2b || // +
      byte === 0x2d || // -
      byte === 0x2e || // .
      byte === 0x5e || // ^
      byte === 0x5f || // _
      byte === 0x60 || // `
      byte === 0x7c || // |
      byte === 0x7e // ~
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/* ────────────────────── header-shape adapters ────────────────────── */

/**
 * Pull every `Link` header value out of a CDP `Network.Response.headers` bag.
 * CDP joins same-name headers with `\n`; we preserve that for the parser to
 * split.
 */
export function getLinkHeaderValuesFromCdp(headers: Record<string, unknown> | undefined): string[] {
  if (!headers) return [];
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'link') continue;
    if (typeof value === 'string' && value.length > 0) out.push(value);
  }
  return out;
}

/**
 * Pull every `Link` header value out of a chrome.webRequest responseHeaders
 * array.
 */
export function getLinkHeaderValuesFromWebRequest(
  headers: Array<{ name: string; value?: string }> | undefined
): string[] {
  if (!headers) return [];
  const out: string[] = [];
  for (const h of headers) {
    if (h.name.toLowerCase() !== 'link') continue;
    if (typeof h.value === 'string' && h.value.length > 0) out.push(h.value);
  }
  return out;
}

/**
 * Pull every `Link` header value out of a Fetch API `Headers` object. Headers
 * collapses same-name values to a comma-joined string per the spec; the
 * parser handles that natively.
 */
export function getLinkHeaderValuesFromHeaders(headers: Headers | undefined): string[] {
  if (!headers) return [];
  const v = headers.get('link');
  return v ? [v] : [];
}
