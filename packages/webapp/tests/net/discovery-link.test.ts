import { describe, expect, it } from 'vitest';
import {
  AI_CATALOG_REL,
  discoveryFingerprint,
  extractCatalog,
  extractCatalogFromCdpHeaders,
  extractCatalogFromFetchHeaders,
  extractCatalogFromWebRequest,
} from '../../src/net/discovery-link.js';
import { parseLinkHeader } from '../../src/net/link-header.js';

describe('extractCatalog', () => {
  it('matches the ai-catalog rel and returns the manifest URL', () => {
    const links = parseLinkHeader(
      `<https://example.com/.well-known/ai-catalog.json>; rel="${AI_CATALOG_REL}"`
    );
    expect(extractCatalog(links)).toEqual({
      kind: 'ai-catalog',
      url: 'https://example.com/.well-known/ai-catalog.json',
    });
  });

  it('resolves a relative manifest href against the base URL', () => {
    const links = parseLinkHeader(
      `</.well-known/ai-catalog.json>; rel="ai-catalog"`,
      'https://example.com/some/page'
    );
    expect(extractCatalog(links)?.url).toBe('https://example.com/.well-known/ai-catalog.json');
  });

  it('matches ai-catalog when it is one of several space-separated rels', () => {
    const links = parseLinkHeader(`</c.json>; rel="alternate ai-catalog"`, 'https://example.com/');
    expect(extractCatalog(links)?.kind).toBe('ai-catalog');
  });

  it('returns null when no ai-catalog rel is present', () => {
    const links = parseLinkHeader('</foo>; rel="describedby"');
    expect(extractCatalog(links)).toBeNull();
  });

  it('is case-sensitive on the rel token (rejects AI-Catalog)', () => {
    const links = parseLinkHeader('</c.json>; rel="AI-Catalog"');
    expect(extractCatalog(links)).toBeNull();
  });

  it('returns the first ai-catalog match when several are present', () => {
    const links = parseLinkHeader(
      `<https://a.example/c.json>; rel="ai-catalog", <https://b.example/c.json>; rel="ai-catalog"`
    );
    expect(extractCatalog(links)?.url).toBe('https://a.example/c.json');
  });
});

describe('extractCatalogFrom* adapters', () => {
  it('extractCatalogFromCdpHeaders parses a CDP-style header bag', () => {
    const result = extractCatalogFromCdpHeaders(
      {
        'content-type': 'text/html',
        link: `</.well-known/ai-catalog.json>; rel="ai-catalog"`,
      },
      'https://example.com/'
    );
    expect(result.match).toEqual({
      kind: 'ai-catalog',
      url: 'https://example.com/.well-known/ai-catalog.json',
    });
    expect(result.links).toHaveLength(1);
  });

  it('extractCatalogFromCdpHeaders returns nulls when no Link header', () => {
    const result = extractCatalogFromCdpHeaders({ 'content-type': 'text/html' });
    expect(result.match).toBeNull();
    expect(result.links).toEqual([]);
  });

  it('extractCatalogFromWebRequest parses a webRequest array', () => {
    const result = extractCatalogFromWebRequest(
      [
        { name: 'Content-Type', value: 'text/html' },
        { name: 'Link', value: `<https://x.example/c.json>; rel="ai-catalog"` },
      ],
      'https://x.example/'
    );
    expect(result.match?.url).toBe('https://x.example/c.json');
  });

  it('extractCatalogFromFetchHeaders parses a Headers object', () => {
    const headers = new Headers();
    headers.set('Link', `<https://x.example/c.json>; rel="ai-catalog"`);
    const result = extractCatalogFromFetchHeaders(headers);
    expect(result.match?.kind).toBe('ai-catalog');
    expect(result.match?.url).toBe('https://x.example/c.json');
  });
});

describe('discoveryFingerprint', () => {
  it('is stable for the same artifact identity', () => {
    const a = discoveryFingerprint({
      origin: 'https://example.com',
      kind: 'ai-catalog',
      url: 'https://example.com/.well-known/ai-catalog.json',
    });
    const b = discoveryFingerprint({
      origin: 'https://example.com',
      kind: 'ai-catalog',
      url: 'https://example.com/.well-known/ai-catalog.json',
    });
    expect(a).toBe(b);
  });

  it('distinguishes kind and url', () => {
    const base = discoveryFingerprint({ origin: 'o', kind: 'ai-catalog', url: 'u1' });
    const otherKind = discoveryFingerprint({ origin: 'o', kind: 'llms-txt', url: 'u1' });
    const otherUrl = discoveryFingerprint({ origin: 'o', kind: 'ai-catalog', url: 'u2' });
    expect(new Set([base, otherKind, otherUrl]).size).toBe(3);
  });

  it('treats omitted and empty fields identically', () => {
    expect(discoveryFingerprint({ url: 'u' })).toBe(
      discoveryFingerprint({ origin: '', kind: '', url: 'u' })
    );
  });
});
