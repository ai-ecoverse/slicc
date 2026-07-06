import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  frameFilename,
  parseArgv,
  pickPageTarget,
  resolveOptions,
  targetMatchesUrl,
  urlFilterFromOptions,
} from './slicc-screencast-lib.mjs';

describe('parseArgv', () => {
  it('splits value-flags (space and = forms) from positionals', () => {
    expect(parseArgv(['--out', '/tmp/x', '--port=9222'])).toEqual({
      flags: { out: '/tmp/x', port: '9222' },
      positional: [],
    });
  });

  it('treats boolean flags as presence-only and keeps unknown --tokens positional', () => {
    expect(parseArgv(['--video', '--url-pattern', 'localhost:87\\d\\d', '--nope'])).toEqual({
      flags: { video: true, 'url-pattern': 'localhost:87\\d\\d' },
      positional: ['--nope'],
    });
  });
});

describe('resolveOptions', () => {
  const saved = { port: process.env.SLICC_CDP_PORT, url: process.env.SLICC_TARGET_URL };
  beforeEach(() => {
    delete process.env.SLICC_CDP_PORT;
    delete process.env.SLICC_TARGET_URL;
  });
  afterEach(() => {
    if (saved.port === undefined) delete process.env.SLICC_CDP_PORT;
    else process.env.SLICC_CDP_PORT = saved.port;
    if (saved.url === undefined) delete process.env.SLICC_TARGET_URL;
    else process.env.SLICC_TARGET_URL = saved.url;
  });

  it('applies defaults with a deterministic out-dir stamp', () => {
    const now = () => Date.parse('2026-07-06T11:22:33.444Z');
    const opts = resolveOptions({}, { now });
    expect(opts).toMatchObject({
      out: '/tmp/slicc-screencast/2026-07-06T11-22-33-444Z',
      port: null,
      url: null,
      urlIsRegex: false,
      durationMs: null,
      format: 'jpeg',
      quality: 80,
      maxWidth: 1280,
      maxHeight: 800,
      everyNth: 1,
      video: false,
      fps: 10,
    });
  });

  it('coerces numerics, seconds→ms duration, and png format', () => {
    const opts = resolveOptions({
      duration: '2.5',
      format: 'png',
      quality: '60',
      'max-width': '640',
      fps: '12',
      video: true,
    });
    expect(opts).toMatchObject({
      durationMs: 2500,
      format: 'png',
      quality: 60,
      maxWidth: 640,
      fps: 12,
      video: true,
    });
  });

  it('prefers --url-pattern over --url and flags it as regex', () => {
    expect(resolveOptions({ url: 'a', 'url-pattern': 'b' })).toMatchObject({
      url: 'b',
      urlIsRegex: true,
    });
    expect(resolveOptions({ url: 'a' })).toMatchObject({ url: 'a', urlIsRegex: false });
  });

  it('falls back to env for port and target url', () => {
    process.env.SLICC_CDP_PORT = '9333';
    process.env.SLICC_TARGET_URL = 'localhost:8787';
    expect(resolveOptions({})).toMatchObject({ port: '9333', url: 'localhost:8787' });
  });
});

describe('targetMatchesUrl', () => {
  it('passes everything when no filter is given', () => {
    expect(targetMatchesUrl('http://x', null)).toBe(true);
  });
  it('does substring vs regex matching', () => {
    expect(targetMatchesUrl('http://localhost:8787/', { value: '8787', isRegex: false })).toBe(
      true
    );
    expect(targetMatchesUrl('http://localhost:8787/', { value: '87\\d\\d', isRegex: true })).toBe(
      true
    );
    expect(targetMatchesUrl('http://localhost:5710/', { value: '8787', isRegex: false })).toBe(
      false
    );
  });
  it('treats an invalid regex pattern as a non-match instead of throwing', () => {
    expect(targetMatchesUrl('http://localhost:8787/', { value: '(', isRegex: true })).toBe(false);
  });
});

describe('pickPageTarget', () => {
  const leader = { type: 'page', url: 'http://localhost:8787/?bridge=x' };
  const bridge = { type: 'page', url: 'http://localhost:5710/?slicc=leader' };
  const app = { type: 'page', url: 'http://localhost:5999/preview/index.html' };
  const blank = { type: 'page', url: 'about:blank' };
  const worker = { type: 'service_worker', url: 'http://localhost:8787/sw.js' };

  it('returns undefined when there is no page target', () => {
    expect(pickPageTarget([worker])).toBeUndefined();
    expect(pickPageTarget([])).toBeUndefined();
  });

  it('prefers a filter match over other pages', () => {
    const got = pickPageTarget([blank, leader], { value: '8787', isRegex: false });
    expect(got).toBe(leader);
  });

  it('returns undefined on an explicit filter miss (never falls back to an arbitrary page)', () => {
    expect(pickPageTarget([blank, app], { value: '8787', isRegex: false })).toBeUndefined();
    expect(pickPageTarget([app, leader], { value: 'nope', isRegex: false })).toBeUndefined();
  });

  it('prefers a known SLICC leader origin (:8787 / :57xx) over an app-under-test tab', () => {
    expect(pickPageTarget([app, leader])).toBe(leader);
    expect(pickPageTarget([app, bridge])).toBe(bridge);
  });

  it('prefers a real http(s) page over about:blank, then the first page, when no filter', () => {
    expect(pickPageTarget([blank, app])).toBe(app);
    expect(pickPageTarget([blank])).toBe(blank);
  });
});

describe('frameFilename', () => {
  it('zero-pads the sequence and honors the format extension', () => {
    expect(frameFilename(42)).toBe('frame-000042.jpeg');
    expect(frameFilename(1, 'png')).toBe('frame-000001.png');
  });
});

describe('urlFilterFromOptions', () => {
  it('builds a filter descriptor or null', () => {
    expect(urlFilterFromOptions({ url: null })).toBeNull();
    expect(urlFilterFromOptions({ url: 'x', urlIsRegex: true })).toEqual({
      value: 'x',
      isRegex: true,
    });
  });
});
