import { describe, expect, it } from 'vitest';
import {
  decodeExtValue,
  formatLink,
  formatLinkHeader,
  getLinkHeaderValuesFromCdp,
  getLinkHeaderValuesFromHeaders,
  getLinkHeaderValuesFromWebRequest,
  parseLinkHeader,
} from '../src/link-header.js';

describe('parseLinkHeader — single value', () => {
  it('parses a minimal link with one rel', () => {
    const links = parseLinkHeader('</foo>; rel="next"');
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('/foo');
    expect(links[0].rel).toEqual(['next']);
  });

  it('parses a link with token rel (unquoted)', () => {
    const links = parseLinkHeader('</foo>; rel=next');
    expect(links[0].rel).toEqual(['next']);
  });

  it('parses multiple rel tokens space-separated', () => {
    const links = parseLinkHeader('</foo>; rel="prev next start"');
    expect(links[0].rel).toEqual(['prev', 'next', 'start']);
  });

  it('parses URI rels (require quoting)', () => {
    const links = parseLinkHeader('</foo>; rel="https://example.com/rel/handoff"');
    expect(links[0].rel).toEqual(['https://example.com/rel/handoff']);
  });

  it('captures type, hreflang, anchor', () => {
    const links = parseLinkHeader(
      '</api>; rel="service-desc"; type="application/openapi+json"; hreflang="en"; anchor="/"'
    );
    expect(links[0].type).toBe('application/openapi+json');
    expect(links[0].hreflang).toBe('en');
    expect(links[0].anchor).toBe('/');
  });
});

describe('parseLinkHeader — multi value', () => {
  it('splits on top-level commas', () => {
    const links = parseLinkHeader('</a>; rel="prev", </b>; rel="next", </c>; rel="last"');
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.href)).toEqual(['/a', '/b', '/c']);
  });

  it('preserves commas inside quoted-string values', () => {
    const links = parseLinkHeader('</a>; rel="next"; title="Hello, world", </b>; rel="prev"');
    expect(links).toHaveLength(2);
    expect(links[0].title).toBe('Hello, world');
    expect(links[1].href).toBe('/b');
  });

  it('merges multiple Link header instances', () => {
    const links = parseLinkHeader(['</a>; rel="next"', '</b>; rel="prev"']);
    expect(links).toHaveLength(2);
    expect(links[0].href).toBe('/a');
    expect(links[1].href).toBe('/b');
  });

  it('treats CDP newline-joined header values as separate values', () => {
    // CDP joins multi-instance headers with `\n`.
    const links = parseLinkHeader('</a>; rel="next"\n</b>; rel="prev"');
    expect(links).toHaveLength(2);
  });

  it('normalizes `\\n` joiners inside array elements (CDP bag passthrough)', () => {
    // The CDP/webRequest adapters preserve newline-joined values per element;
    // previously only top-level string inputs were normalized, so a single
    // array element carrying `\n`-joined Link instances silently dropped all
    // but the first.
    const links = parseLinkHeader(['</a>; rel="next"\n</b>; rel="prev"', '</c>; rel="last"']);
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.href)).toEqual(['/a', '/b', '/c']);
  });
});

describe('parseLinkHeader — RFC 8187 ext-value', () => {
  it("decodes `param*=UTF-8''…` and prefers it over the regular param", () => {
    const links = parseLinkHeader(
      '</>; rel="https://www.sliccy.ai/rel/handoff"; title="Fallback"; title*=UTF-8\'\'Continue%20%F0%9F%9A%80'
    );
    expect(links[0].title).toBe('Continue 🚀');
  });

  it('decodes plain ASCII ext-values idempotently', () => {
    const links = parseLinkHeader('</>; rel="x"; title*=UTF-8\'\'hello');
    expect(links[0].title).toBe('hello');
  });

  it('drops non-UTF-8 ext-values (keeps regular fallback)', () => {
    const links = parseLinkHeader('</>; rel="x"; title="fallback"; title*=ISO-8859-1\'\'ignored');
    expect(links[0].title).toBe('fallback');
  });

  it('handles malformed percent sequences in ext-value', () => {
    const links = parseLinkHeader('</>; rel="x"; title*=UTF-8\'\'bad%FFsequence');
    // decodeURIComponent throws on lone %FF without 2 hex digits — safe path
    // returns null, so title falls through to undefined here (no fallback).
    expect(links[0].title).toBeUndefined();
  });
});

describe('parseLinkHeader — base URL resolution', () => {
  it('resolves relative href against base', () => {
    const links = parseLinkHeader('</foo>; rel="next"', 'https://example.com/page');
    expect(links[0].href).toBe('https://example.com/foo');
  });

  it('falls back to the raw URI when the base makes URL construction throw', () => {
    const links = parseLinkHeader('</foo>; rel="next"', 'not a valid base url');
    expect(links[0].href).toBe('/foo');
  });

  it('preserves absolute href', () => {
    const links = parseLinkHeader('<https://other.example/x>; rel="next"', 'https://example.com/');
    expect(links[0].href).toBe('https://other.example/x');
  });

  it('resolves anchor against base', () => {
    const links = parseLinkHeader('</foo>; rel="x"; anchor="/ctx"', 'https://example.com/page');
    expect(links[0].anchor).toBe('https://example.com/ctx');
  });

  it('resolves empty <> as the base itself', () => {
    const links = parseLinkHeader('<>; rel="x"', 'https://example.com/page');
    expect(links[0].href).toBe('https://example.com/page');
  });
});

describe('parseLinkHeader — quoted strings with escapes', () => {
  it('unescapes backslash-quote inside quoted string', () => {
    const links = parseLinkHeader('</>; rel="x"; title="he said \\"hi\\""');
    expect(links[0].title).toBe('he said "hi"');
  });

  it('preserves semicolons and equals inside quoted string', () => {
    const links = parseLinkHeader('</>; rel="x"; title="a; b = c"');
    expect(links[0].title).toBe('a; b = c');
  });
});

describe('parseLinkHeader — robustness', () => {
  it('returns [] for null / undefined / empty', () => {
    expect(parseLinkHeader(null)).toEqual([]);
    expect(parseLinkHeader(undefined)).toEqual([]);
    expect(parseLinkHeader('')).toEqual([]);
    expect(parseLinkHeader([])).toEqual([]);
  });

  it('returns [] for a value outside the declared input type (defensive)', () => {
    // Callers on an untyped wire (CDP, chrome.webRequest, JSON.parse) can
    // hand back something that isn't string | string[] at runtime even
    // though the TS signature disallows it.
    expect(parseLinkHeader(42 as unknown as string)).toEqual([]);
  });

  it('skips a malformed value and continues to the next', () => {
    const links = parseLinkHeader('garbage, </ok>; rel="next"');
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('/ok');
  });

  it('skips a malformed value containing a backslash-escaped quoted string', () => {
    // Exercises skipToNextValue's in-quote state machine: opening a quote,
    // skipping a backslash-escaped char inside it, closing the quote, then
    // finding the terminating comma.
    const links = parseLinkHeader('bad"x\\"y", </ok>; rel="next"');
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('/ok');
  });

  it('skips trailing unterminated garbage with no comma at the end', () => {
    const links = parseLinkHeader('</ok>; rel="next", garbage');
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('/ok');
  });

  it('ignores duplicate rel parameter (first wins per RFC 8288)', () => {
    const links = parseLinkHeader('</>; rel="first"; rel="second"');
    expect(links[0].rel).toEqual(['first']);
  });

  it('does not throw on unterminated angle bracket', () => {
    expect(() => parseLinkHeader('</broken')).not.toThrow();
  });

  it('accepts a bare parameter with no `=` value', () => {
    const links = parseLinkHeader('</>; rel="x"; bareflag');
    expect(links[0].params.bareflag).toBe('');
  });

  it('tolerates trailing whitespace after the last parameter', () => {
    const links = parseLinkHeader('</>; rel="x"  ');
    expect(links).toHaveLength(1);
  });

  it('tolerates trailing whitespace between link-values with nothing after', () => {
    const links = parseLinkHeader('</a>; rel="x",   ');
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('/a');
  });

  it('recovers from a stray token after a parameter with no separator', () => {
    const links = parseLinkHeader('</a>; rel="x" garbage, </b>; rel="y"');
    expect(links.map((l) => l.href)).toEqual(['/a', '/b']);
  });

  it('recovers from a semicolon immediately followed by an invalid name start', () => {
    const links = parseLinkHeader('</a>; rel="x";=oops, </b>; rel="y"');
    expect(links.map((l) => l.href)).toEqual(['/a', '/b']);
  });

  it('normalizes an uppercase parameter name to lowercase', () => {
    const links = parseLinkHeader('</>; REL="next"');
    expect(links[0].rel).toEqual(['next']);
  });
});

describe('decodeExtValue', () => {
  it('decodes UTF-8 percent-encoded values', () => {
    expect(decodeExtValue("UTF-8''Hello%20%F0%9F%9A%80")).toBe('Hello 🚀');
  });

  it('rejects non-UTF-8 charsets', () => {
    expect(decodeExtValue("ISO-8859-1''abc")).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(decodeExtValue('no-quote')).toBeNull();
    expect(decodeExtValue("UTF-8'")).toBeNull();
  });
});

describe('formatLink / formatLinkHeader', () => {
  it('emits a basic link with token rel', () => {
    expect(formatLink({ href: '/api', rel: 'api-catalog' })).toBe('</api>; rel=api-catalog');
  });

  it('quotes URI rels (have non-token chars)', () => {
    expect(formatLink({ href: '/', rel: 'https://www.sliccy.ai/rel/handoff' })).toBe(
      '</>; rel="https://www.sliccy.ai/rel/handoff"'
    );
  });

  it('joins multiple rels with a space', () => {
    expect(formatLink({ href: '/', rel: ['service-desc', 'service-doc'] })).toBe(
      '</>; rel="service-desc service-doc"'
    );
  });

  it('uses RFC 8187 for non-Latin1 title', () => {
    const out = formatLink({
      href: '',
      rel: 'https://www.sliccy.ai/rel/handoff',
      title: 'Continue 🚀',
    });
    expect(out).toContain("title*=UTF-8''Continue%20%F0%9F%9A%80");
  });

  it('forces ext-encoding when extEncode lists the param', () => {
    const out = formatLink({
      href: '',
      rel: 'x',
      title: 'plain',
      extEncode: ['title'],
    });
    expect(out).toContain("title*=UTF-8''plain");
  });

  it('escapes CR/LF inside quoted parameter values', () => {
    const out = formatLink({ href: '/', rel: 'x', title: 'foo\r\nX-Injected: bar' });
    // Plain ASCII so it stays as quoted-string, but CR/LF are percent-encoded.
    expect(out).toContain('%0D%0A');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\n');
  });

  it('skips reserved param names already emitted from top-level fields', () => {
    // `rel` is both a top-level LinkInput field (always emitted first) and
    // present in `params` here — the reserved-name skip must not double-emit
    // it via the generic params loop.
    const out = formatLink({ href: '/', rel: 'x', params: { rel: 'duplicate', foo: 'bar' } });
    expect(out).toBe('</>; rel=x; foo=bar');
  });

  it('percent-encodes CR/LF carried directly in `rel` (bypasses ext-encoding)', () => {
    // `rel` always goes through the plain quoted-string formatter, not the
    // needsExtEncoding()-gated appendParam() path other fields use.
    const out = formatLink({ href: '/', rel: 'foo\r\nbar' });
    expect(out).toContain('%0D%0A');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\n');
  });

  it('joins multiple links with comma-space', () => {
    const out = formatLinkHeader([
      { href: '/a', rel: 'next' },
      { href: '/b', rel: 'prev' },
    ]);
    expect(out).toBe('</a>; rel=next, </b>; rel=prev');
  });

  it('round-trips through the parser', () => {
    const built = formatLinkHeader([
      { href: 'https://github.com/o/r', rel: 'https://www.sliccy.ai/rel/upskill' },
      {
        href: '',
        rel: 'https://www.sliccy.ai/rel/handoff',
        title: 'Continue the signup flow',
      },
    ]);
    const parsed = parseLinkHeader(built);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].rel).toContain('https://www.sliccy.ai/rel/upskill');
    expect(parsed[0].href).toBe('https://github.com/o/r');
    expect(parsed[1].rel).toContain('https://www.sliccy.ai/rel/handoff');
    expect(parsed[1].title).toBe('Continue the signup flow');
  });
});

describe('header-shape adapters', () => {
  it('extracts Link from CDP-style headers (case-insensitive)', () => {
    expect(getLinkHeaderValuesFromCdp({ Link: '</a>; rel="x"' })).toEqual(['</a>; rel="x"']);
    expect(getLinkHeaderValuesFromCdp({ link: '</b>; rel="x"' })).toEqual(['</b>; rel="x"']);
    expect(getLinkHeaderValuesFromCdp({})).toEqual([]);
    expect(getLinkHeaderValuesFromCdp(undefined)).toEqual([]);
  });

  it('extracts Link from chrome.webRequest array', () => {
    expect(
      getLinkHeaderValuesFromWebRequest([
        { name: 'Content-Type', value: 'text/html' },
        { name: 'link', value: '</a>; rel="x"' },
      ])
    ).toEqual(['</a>; rel="x"']);
  });

  it('returns [] for an undefined webRequest headers array', () => {
    expect(getLinkHeaderValuesFromWebRequest(undefined)).toEqual([]);
  });

  it('extracts Link from a Headers object', () => {
    const h = new Headers();
    h.append('link', '</a>; rel="next"');
    h.append('link', '</b>; rel="prev"');
    // Headers.get() returns comma-joined for multi-value names.
    expect(getLinkHeaderValuesFromHeaders(h)).toEqual(['</a>; rel="next", </b>; rel="prev"']);
  });

  it('returns [] for undefined Headers', () => {
    expect(getLinkHeaderValuesFromHeaders(undefined)).toEqual([]);
  });
});
