import { describe, it, expect } from 'vitest';
import { parseLinkHeader } from '../../src/net/link-header.js';
import {
  HANDOFF_REL,
  UPSKILL_REL,
  extractHandoff,
  extractHandoffFromCdpHeaders,
  extractHandoffFromFetchHeaders,
  extractHandoffFromWebRequest,
} from '../../src/net/handoff-link.js';

describe('extractHandoff', () => {
  it('matches the upskill rel and returns the GitHub URL as target', () => {
    const links = parseLinkHeader(`<https://github.com/o/r>; rel="${UPSKILL_REL}"`);
    expect(extractHandoff(links)).toEqual({
      verb: 'upskill',
      target: 'https://github.com/o/r',
    });
  });

  it('matches the handoff rel with a title parameter as instruction', () => {
    const links = parseLinkHeader(
      `<https://example.com/page>; rel="${HANDOFF_REL}"; title="Continue the signup flow"`,
      'https://example.com/page'
    );
    expect(extractHandoff(links)).toEqual({
      verb: 'handoff',
      target: 'https://example.com/page',
      instruction: 'Continue the signup flow',
    });
  });

  it('decodes a UTF-8 title* into instruction (emoji + CJK)', () => {
    const links = parseLinkHeader(
      `<>; rel="${HANDOFF_REL}"; title*=UTF-8''Continue%20%F0%9F%9A%80%20%E4%BD%A0%E5%A5%BD`,
      'https://example.com/page'
    );
    expect(extractHandoff(links)).toEqual({
      verb: 'handoff',
      target: 'https://example.com/page',
      instruction: 'Continue 🚀 你好',
    });
  });

  it('returns null when no recognised rel is present', () => {
    const links = parseLinkHeader('</foo>; rel="next"');
    expect(extractHandoff(links)).toBeNull();
  });

  it('rejects rels with wrong case (URI comparison is case-sensitive)', () => {
    const links = parseLinkHeader('</>; rel="https://www.SLICCY.ai/rel/handoff"');
    expect(extractHandoff(links)).toBeNull();
  });

  it('returns the first match when multiple recognised rels are present', () => {
    const links = parseLinkHeader(
      `<https://github.com/o/r>; rel="${UPSKILL_REL}", <>; rel="${HANDOFF_REL}"; title="x"`,
      'https://example.com/'
    );
    expect(extractHandoff(links)?.verb).toBe('upskill');
  });

  it('drops empty instruction strings', () => {
    const links = parseLinkHeader(`</>; rel="${HANDOFF_REL}"; title=""`);
    const match = extractHandoff(links);
    expect(match?.verb).toBe('handoff');
    expect(match?.instruction).toBeUndefined();
  });
});

describe('extractHandoffFrom* adapters', () => {
  it('extractHandoffFromCdpHeaders parses CDP-style header bag', () => {
    const result = extractHandoffFromCdpHeaders(
      {
        'content-type': 'text/html',
        link: `<https://github.com/o/r>; rel="${UPSKILL_REL}"`,
      },
      'https://www.sliccy.ai/handoff'
    );
    expect(result.match).toEqual({
      verb: 'upskill',
      target: 'https://github.com/o/r',
    });
    expect(result.links).toHaveLength(1);
  });

  it('extractHandoffFromCdpHeaders returns nulls when no Link header', () => {
    const result = extractHandoffFromCdpHeaders({ 'content-type': 'text/html' });
    expect(result.match).toBeNull();
    expect(result.links).toEqual([]);
  });

  it('extractHandoffFromWebRequest parses webRequest array', () => {
    const result = extractHandoffFromWebRequest(
      [
        { name: 'Content-Type', value: 'text/html' },
        { name: 'Link', value: `<>; rel="${HANDOFF_REL}"; title="do it"` },
      ],
      'https://example.com/'
    );
    expect(result.match?.verb).toBe('handoff');
    expect(result.match?.instruction).toBe('do it');
  });

  it('extractHandoffFromFetchHeaders parses Headers object', () => {
    const headers = new Headers();
    headers.set('Link', `<https://github.com/o/r>; rel="${UPSKILL_REL}"`);
    const result = extractHandoffFromFetchHeaders(headers);
    expect(result.match?.verb).toBe('upskill');
    expect(result.match?.target).toBe('https://github.com/o/r');
  });
});
