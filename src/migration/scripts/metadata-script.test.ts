// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { METADATA_EXTRACT_SCRIPT } from './metadata-script.js';

describe('METADATA_EXTRACT_SCRIPT', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.title = '';
  });

  function runScript(): {
    title: string;
    description: string;
    canonical: string | null;
    ogTags: Record<string, string>;
    twitterTags: Record<string, string>;
    jsonLd: unknown[];
  } {
    // eslint-disable-next-line no-eval
    return eval(METADATA_EXTRACT_SCRIPT);
  }

  it('is valid JavaScript', () => {
    expect(() => new Function(METADATA_EXTRACT_SCRIPT)).not.toThrow();
  });

  it('extracts page title', () => {
    document.title = 'Test Page Title';
    const result = runScript();
    expect(result.title).toBe('Test Page Title');
  });

  it('extracts meta description', () => {
    document.head.innerHTML =
      '<meta name="description" content="A page about testing">';
    const result = runScript();
    expect(result.description).toBe('A page about testing');
  });

  it('extracts canonical link', () => {
    document.head.innerHTML =
      '<link rel="canonical" href="https://example.com/page">';
    const result = runScript();
    expect(result.canonical).toBe('https://example.com/page');
  });

  it('extracts Open Graph tags', () => {
    document.head.innerHTML = [
      '<meta property="og:title" content="OG Title">',
      '<meta property="og:description" content="OG Desc">',
      '<meta property="og:image" content="https://example.com/img.png">',
      '<meta property="og:type" content="website">',
    ].join('');
    const result = runScript();
    expect(result.ogTags).toEqual({
      'og:title': 'OG Title',
      'og:description': 'OG Desc',
      'og:image': 'https://example.com/img.png',
      'og:type': 'website',
    });
  });

  it('extracts Twitter Card tags from name attribute', () => {
    document.head.innerHTML = [
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:site" content="@example">',
      '<meta name="twitter:title" content="Tweet Title">',
    ].join('');
    const result = runScript();
    expect(result.twitterTags).toEqual({
      'twitter:card': 'summary_large_image',
      'twitter:site': '@example',
      'twitter:title': 'Tweet Title',
    });
  });

  it('extracts Twitter Card tags from property attribute', () => {
    document.head.innerHTML =
      '<meta property="twitter:image" content="https://example.com/tw.png">';
    const result = runScript();
    expect(result.twitterTags).toEqual({
      'twitter:image': 'https://example.com/tw.png',
    });
  });

  it('extracts JSON-LD scripts', () => {
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: 'Test',
    };
    document.head.innerHTML =
      `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;
    const result = runScript();
    expect(result.jsonLd).toEqual([jsonLd]);
  });

  it('handles multiple JSON-LD scripts', () => {
    const ld1 = { '@type': 'Organization', name: 'Acme' };
    const ld2 = { '@type': 'BreadcrumbList', itemListElement: [] };
    document.head.innerHTML = [
      `<script type="application/ld+json">${JSON.stringify(ld1)}</script>`,
      `<script type="application/ld+json">${JSON.stringify(ld2)}</script>`,
    ].join('');
    const result = runScript();
    expect(result.jsonLd).toEqual([ld1, ld2]);
  });

  it('handles malformed JSON-LD gracefully', () => {
    document.head.innerHTML =
      '<script type="application/ld+json">{ invalid json }</script>';
    const result = runScript();
    expect(result.jsonLd).toEqual([]);
  });

  it('handles missing tags gracefully', () => {
    const result = runScript();
    expect(result.title).toBe('');
    expect(result.description).toBe('');
    expect(result.canonical).toBeNull();
    expect(result.ogTags).toEqual({});
    expect(result.twitterTags).toEqual({});
    expect(result.jsonLd).toEqual([]);
  });

  it('extracts all fields together', () => {
    document.head.innerHTML = [
      '<meta name="description" content="Full description">',
      '<link rel="canonical" href="https://example.com/full">',
      '<meta property="og:title" content="Full OG">',
      '<meta name="twitter:card" content="summary">',
      `<script type="application/ld+json">{"@type":"WebPage"}</script>`,
    ].join('');
    document.title = 'Full Page';
    const result = runScript();
    expect(result.title).toBe('Full Page');
    expect(result.description).toBe('Full description');
    expect(result.canonical).toBe('https://example.com/full');
    expect(result.ogTags).toEqual({ 'og:title': 'Full OG' });
    expect(result.twitterTags).toEqual({ 'twitter:card': 'summary' });
    expect(result.jsonLd).toEqual([{ '@type': 'WebPage' }]);
  });

  it('ignores meta tags without content', () => {
    document.head.innerHTML = [
      '<meta name="viewport" content="width=device-width">',
      '<meta charset="utf-8">',
      '<meta property="og:locale" content="en_US">',
    ].join('');
    const result = runScript();
    expect(result.ogTags).toEqual({ 'og:locale': 'en_US' });
    expect(result.twitterTags).toEqual({});
  });
});
