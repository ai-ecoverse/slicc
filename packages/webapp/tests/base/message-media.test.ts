/**
 * Tests for the chat media decision layer — which element a markdown
 * `![alt](href)` becomes, and whether its href is rewritten to `/preview/*`.
 */

import { describe, expect, it } from 'vitest';
import { resolveMessageMedia, stripUrlSuffix } from '../../src/base/message-media.js';

describe('stripUrlSuffix', () => {
  it('drops a query string', () => {
    expect(stripUrlSuffix('/shared/a.png?v=2')).toBe('/shared/a.png');
  });

  it('drops a hash', () => {
    expect(stripUrlSuffix('/shared/a.png#top')).toBe('/shared/a.png');
  });

  it('leaves a bare path alone', () => {
    expect(stripUrlSuffix('/shared/a.png')).toBe('/shared/a.png');
  });
});

describe('resolveMessageMedia', () => {
  describe('VFS path resolution', () => {
    it('routes a rooted image path through /preview', () => {
      const media = resolveMessageMedia('/shared/clip/frame.png');
      expect(media).toEqual({
        kind: 'image',
        src: expect.stringContaining('/preview/shared/clip/frame.png'),
      });
    });

    it('routes a rooted video path through /preview', () => {
      const media = resolveMessageMedia('/shared/clip/cut.mp4');
      expect(media?.kind).toBe('video');
      expect(media?.src).toContain('/preview/shared/clip/cut.mp4');
    });

    // The whole point of the rewrite: unrewritten, this path resolves against
    // the app origin, where the SPA fallback answers 200 + text/html and the
    // element silently fails to decode.
    it('never leaves a rooted VFS path unrewritten', () => {
      expect(resolveMessageMedia('/shared/a.png')?.src).not.toBe('/shared/a.png');
    });
  });

  describe('video typing', () => {
    it.each([
      ['/shared/a.mp4', 'video/mp4'],
      ['/shared/a.webm', 'video/webm'],
      ['/shared/a.mov', 'video/quicktime'],
      ['/shared/a.m4v', 'video/x-m4v'],
      ['/shared/a.ogv', 'video/ogg'],
    ])('%s is a video', (href, mimeType) => {
      expect(resolveMessageMedia(href)).toMatchObject({ kind: 'video', mimeType });
    });

    it.each([
      ['/shared/a.mp3', 'audio/mpeg'],
      ['/shared/a.wav', 'audio/wav'],
      ['/shared/a.ogg', 'audio/ogg'],
      ['/shared/a.m4a', 'audio/mp4'],
      ['/shared/a.flac', 'audio/flac'],
    ])('%s is audio', (href, mimeType) => {
      expect(resolveMessageMedia(href)).toMatchObject({ kind: 'audio', mimeType });
    });

    // `.ogg` is audio and `.ogv` is video — the one pair the table splits.
    it('separates .ogg from .ogv', () => {
      expect(resolveMessageMedia('/shared/a.ogg')?.kind).toBe('audio');
      expect(resolveMessageMedia('/shared/a.ogv')?.kind).toBe('video');
    });

    it.each(['/shared/a.png', '/shared/a.jpg', '/shared/a.gif', '/shared/a.webp', '/shared/a.svg'])(
      '%s is an image',
      (href) => {
        expect(resolveMessageMedia(href)?.kind).toBe('image');
      }
    );

    it('types past a query string', () => {
      expect(resolveMessageMedia('/shared/a.mp4?t=12')?.kind).toBe('video');
    });

    it('is case-insensitive about the extension', () => {
      expect(resolveMessageMedia('/shared/A.MP4')?.kind).toBe('video');
    });
  });

  describe('non-VFS hrefs pass through unchanged', () => {
    it.each([
      'https://example.com/a.png',
      'http://example.com/a.png',
      '//example.com/a.png',
      'blob:https://example.com/abc',
    ])('%s keeps its src', (href) => {
      expect(resolveMessageMedia(href)?.src).toBe(href);
    });

    it('classifies a remote video by extension', () => {
      expect(resolveMessageMedia('https://example.com/a.mp4')?.kind).toBe('video');
    });

    it('leaves a relative path alone — there is no cwd to resolve it against', () => {
      expect(resolveMessageMedia('frame.png')?.src).toBe('frame.png');
    });

    it('reads the type out of a data URL rather than the extension', () => {
      expect(resolveMessageMedia('data:image/png;base64,AAAA')?.kind).toBe('image');
      expect(resolveMessageMedia('data:video/mp4;base64,AAAA')?.kind).toBe('video');
      expect(resolveMessageMedia('data:audio/mpeg;base64,AAAA')?.kind).toBe('audio');
    });
  });

  describe('references the renderer must not touch', () => {
    // hydrateDips() keys off img[src$=".shtml"]; rewriting the src would
    // break the handshake and the dip would never mount.
    it('returns null for a .shtml dip reference', () => {
      expect(resolveMessageMedia('/shared/palette.shtml')).toBeNull();
    });

    it('returns null for a .shtml reference with a query string', () => {
      expect(resolveMessageMedia('/shared/palette.shtml?v=1')).toBeNull();
    });

    it.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'vbscript:x', 'file:///etc/passwd'])(
      'returns null for %s',
      (href) => {
        expect(resolveMessageMedia(href)).toBeNull();
      }
    );

    it('returns null for an empty or blank href', () => {
      expect(resolveMessageMedia('')).toBeNull();
      expect(resolveMessageMedia('   ')).toBeNull();
    });
  });

  it('treats an unknown extension as an image', () => {
    expect(resolveMessageMedia('/shared/mystery')?.kind).toBe('image');
  });
});
