import { describe, expect, it } from 'vitest';
import { decodeEntities, parseOpenGraph } from '../../src/core/og-meta.js';

const BASE = 'https://example.com/blog/post';

describe('parseOpenGraph', () => {
  it('reads the og: card', () => {
    const html = `<html><head>
      <meta property="og:title" content="Hello &amp; welcome">
      <meta property="og:description" content="A post about things">
      <meta property="og:image" content="https://cdn.example.com/card.png">
      <meta property="og:site_name" content="Example">
    </head><body></body></html>`;
    expect(parseOpenGraph(html, BASE)).toEqual({
      title: 'Hello & welcome',
      description: 'A post about things',
      image: 'https://cdn.example.com/card.png',
      siteName: 'Example',
    });
  });

  it('accepts attributes in any order and quoting style', () => {
    const html = `<head><meta content='Reversed' property='og:title'><meta name=description content=plain></head>`;
    expect(parseOpenGraph(html, BASE)).toEqual({ title: 'Reversed', description: 'plain' });
  });

  it('falls back to twitter tags, then <title> and description', () => {
    const twitter = `<head><meta name="twitter:title" content="Tw"><meta name="twitter:image" content="/tw.png"></head>`;
    expect(parseOpenGraph(twitter, BASE)).toEqual({
      title: 'Tw',
      image: 'https://example.com/tw.png',
    });
    const plain = `<head><title> Plain  title </title><meta name="description" content="d"></head>`;
    expect(parseOpenGraph(plain, BASE)).toEqual({ title: 'Plain title', description: 'd' });
  });

  it('resolves relative images against the page and drops non-web schemes', () => {
    expect(
      parseOpenGraph(`<head><meta property="og:image" content="../img/a.jpg"></head>`, BASE).image
    ).toBe('https://example.com/img/a.jpg');
    expect(
      parseOpenGraph(`<head><meta property="og:image" content="javascript:alert(1)"></head>`, BASE)
        .image
    ).toBeUndefined();
    expect(
      parseOpenGraph(
        `<head><meta property="og:image" content="data:image/png;base64,AAAA"></head>`,
        BASE
      ).image
    ).toBeUndefined();
  });

  it('keeps the first of repeated tags and prefers secure_url', () => {
    const html = `<head>
      <meta property="og:image" content="https://a.example/1.png">
      <meta property="og:image" content="https://a.example/2.png">
    </head>`;
    expect(parseOpenGraph(html, BASE).image).toBe('https://a.example/1.png');
    const secure = `<head><meta property="og:image" content="http://a/x.png"><meta property="og:image:secure_url" content="https://a/x.png"></head>`;
    expect(parseOpenGraph(secure, BASE).image).toBe('https://a/x.png');
  });

  it('only scans the head', () => {
    const html = `<head><title>T</title></head><body><meta property="og:title" content="Body"></body>`;
    expect(parseOpenGraph(html, BASE).title).toBe('T');
  });

  it('clamps very long fields', () => {
    const long = 'x'.repeat(1000);
    const card = parseOpenGraph(
      `<head><meta property="og:description" content="${long}"></head>`,
      BASE
    );
    expect(card.description?.length).toBe(400);
    expect(card.description?.endsWith('…')).toBe(true);
  });

  it('returns an empty card for a page with nothing', () => {
    expect(parseOpenGraph('<html><body>hi</body></html>', BASE)).toEqual({});
  });
});

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities and leaves unknown ones', () => {
    expect(decodeEntities('a &amp; b &#39;c&#x27; &rsquo; &bogus;')).toBe("a & b 'c' ’ &bogus;");
  });

  it('leaves out-of-range code points alone', () => {
    expect(decodeEntities('&#0; &#x110000;')).toBe('&#0; &#x110000;');
  });
});
