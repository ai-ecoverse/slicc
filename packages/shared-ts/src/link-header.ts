export interface ParsedLink {
  href: string;

  rel: string[];

  anchor?: string;

  type?: string;

  title?: string;

  hreflang?: string;

  params: Record<string, string>;
}

export interface LinkInput {
  href: string;

  rel: string[] | string;
  type?: string;
  title?: string;
  hreflang?: string;
  anchor?: string;

  params?: Record<string, string>;

  extEncode?: string[];
}

function normalizeLinkHeaderInput(input: string | string[] | null | undefined): string | null {
  if (input == null) return null;

  if (Array.isArray(input)) {
    const headerString = input.join(', ').replace(/\n/g, ', ');
    return headerString.length === 0 ? null : headerString;
  }
  if (typeof input === 'string') {
    const headerString = input.replace(/\n/g, ', ');
    return headerString.length === 0 ? null : headerString;
  }
  return null;
}

function readUnquotedParamValue(headerString: string, i: number): { value: string; end: number } {
  const len = headerString.length;
  const start = i;
  while (
    i < len &&
    headerString[i] !== ';' &&
    headerString[i] !== ',' &&
    !isOWSChar(headerString[i])
  )
    i++;
  return { value: headerString.slice(start, i), end: i };
}

function readParamValue(headerString: string, i: number): { value: string; end: number } {
  const len = headerString.length;
  i = skipOWS(headerString, i);
  if (i >= len || headerString[i] !== '=') return { value: '', end: i };
  i++;
  i = skipOWS(headerString, i);
  if (i < len && headerString[i] === '"') return readQuotedString(headerString, i);
  return readUnquotedParamValue(headerString, i);
}

function readParamName(headerString: string, i: number): { name: string; end: number } | null {
  const len = headerString.length;
  const nameStart = i;
  while (i < len && isTokenChar(headerString.charCodeAt(i))) i++;
  /* c8 ignore next 2 -- unreachable: `*` (0x2a) is itself a tchar (see
     isTokenChar's `case 0x2a`), so the while loop above already consumes a
     trailing `*` before this check can run. */
  if (i < len && headerString[i] === '*') i++;
  if (nameStart === i) return null;
  return { name: headerString.slice(nameStart, i).toLowerCase(), end: i };
}

function parseLinkParameters(
  headerString: string,
  startIndex: number
): { params: Array<[string, string]>; endIndex: number } {
  const rawParams: Array<[string, string]> = [];
  const len = headerString.length;
  let i = startIndex;

  while (i < len) {
    i = skipOWS(headerString, i);
    if (i >= len) break;
    if (headerString[i] === ',') return { params: rawParams, endIndex: i + 1 };
    if (headerString[i] !== ';') {
      return { params: rawParams, endIndex: skipToNextValue(headerString, i) };
    }
    i++;
    i = skipOWS(headerString, i);

    const parsedName = readParamName(headerString, i);
    if (!parsedName) {
      return { params: rawParams, endIndex: skipToNextValue(headerString, i) };
    }
    const { value, end } = readParamValue(headerString, parsedName.end);
    rawParams.push([parsedName.name, value]);
    i = end;
  }

  return { params: rawParams, endIndex: i };
}

export function parseLinkHeader(
  input: string | string[] | null | undefined,
  baseUrl?: string
): ParsedLink[] {
  const headerString = normalizeLinkHeaderInput(input);
  if (headerString == null) return [];

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

    const { params: rawParams, endIndex } = parseLinkParameters(headerString, uriEnd + 1);
    i = endIndex;

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
  if (code >= 0x30 && code <= 0x39) return true;
  if (code >= 0x41 && code <= 0x5a) return true;
  if (code >= 0x61 && code <= 0x7a) return true;
  switch (code) {
    case 0x21:
    case 0x23:
    case 0x24:
    case 0x25:
    case 0x26:
    case 0x27:
    case 0x2a:
    case 0x2b:
    case 0x2d:
    case 0x2e:
    case 0x5e:
    case 0x5f:
    case 0x60:
    case 0x7c:
    case 0x7e:
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

    if (name === 'rel' && 'rel' in params) continue;
    params[name] = value;
  }

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

export function formatLink(link: LinkInput): string {
  const rels = Array.isArray(link.rel) ? link.rel : [link.rel];
  const relValue = rels.join(' ');

  const ext = new Set(link.extEncode ?? []);

  const parts: string[] = [`<${link.href}>`];

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
    parts.push(`${name}*=UTF-8''${encodeRFC8187(value)}`);
  } else {
    parts.push(`${name}=${formatParamValue(value)}`);
  }
}

function needsExtEncoding(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code > 0xff || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function formatParamValue(value: string): string {
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
  const bytes = new TextEncoder().encode(value);
  let out = '';
  for (const byte of bytes) {
    if (
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x21 ||
      byte === 0x23 ||
      byte === 0x24 ||
      byte === 0x26 ||
      byte === 0x2b ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5e ||
      byte === 0x5f ||
      byte === 0x60 ||
      byte === 0x7c ||
      byte === 0x7e
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

export interface CdpNetworkResponseHeaders {
  readonly [headerName: string]: unknown;
}

export function getLinkHeaderValuesFromCdp(
  headers: CdpNetworkResponseHeaders | undefined
): string[] {
  if (!headers) return [];
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'link') continue;
    if (typeof value === 'string' && value.length > 0) out.push(value);
  }
  return out;
}

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

export function getLinkHeaderValuesFromHeaders(headers: Headers | undefined): string[] {
  if (!headers) return [];
  const v = headers.get('link');
  return v ? [v] : [];
}
