import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_MASKABLE_SECRET_LENGTH } from '../src/secret-masking.js';
import {
  type FetchProxySecretSource,
  type ForbiddenInfo,
  SecretsPipeline,
} from '../src/secrets-pipeline.js';

function source(
  entries: { name: string; value: string; domains: string[] }[]
): FetchProxySecretSource {
  return {
    get: async (name) => entries.find((e) => e.name === name)?.value,
    listAll: async () => entries.map((e) => ({ ...e })),
  };
}

describe('SecretsPipeline (skeleton)', () => {
  let pipeline: SecretsPipeline;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        { name: 'GITHUB_TOKEN', value: 'ghp_realToken123', domains: ['api.github.com'] },
      ]),
    });
    await pipeline.reload();
  });

  it('mask is deterministic for the same (sessionId, name, value)', async () => {
    const a = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const b = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    expect(a).toBe(b);
  });

  it('getMaskedEntries returns {name, maskedValue, domains}[]', () => {
    const entries = pipeline.getMaskedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      name: 'GITHUB_TOKEN',
      maskedValue: expect.stringMatching(/^ghp_[a-f0-9]+$/),
      domains: ['api.github.com'],
    });
  });

  it('unmaskHeaders mutates the headers param in place and returns {forbidden?} only', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const headers: Record<string, string> = { authorization: `Bearer ${masked}` };
    const result = pipeline.unmaskHeaders(headers, 'api.github.com');
    expect(result.forbidden).toBeUndefined();
    expect(headers.authorization).toBe('Bearer ghp_realToken123');
  });

  it('unmaskHeaders returns {forbidden: {secretName, hostname}} for non-allowed domain', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const headers: Record<string, string> = { authorization: `Bearer ${masked}` };
    const result = pipeline.unmaskHeaders(headers, 'evil.example.com');
    expect(result.forbidden).toEqual({ secretName: 'GITHUB_TOKEN', hostname: 'evil.example.com' });
  });

  it('unmaskBody(text, hostname) returns {text} with masked→real where domain allowed', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const result = pipeline.unmaskBody(`payload ${masked}`, 'api.github.com');
    expect(result.text).toBe('payload ghp_realToken123');
  });

  it('unmaskBody leaves masked-value untouched on domain mismatch (no forbidden)', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const result = pipeline.unmaskBody(`payload ${masked}`, 'evil.example.com');
    expect(result.text).toBe(`payload ${masked}`);
  });

  it('scrubResponse replaces real → masked', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const out = pipeline.scrubResponse('hello ghp_realToken123 world');
    expect(out).toBe(`hello ${masked} world`);
  });
});

describe('unmaskAuthorizationBasic', () => {
  let pipeline: SecretsPipeline;
  let masked: string;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        {
          name: 'GITHUB_TOKEN',
          value: 'ghp_realToken123',
          domains: ['github.com', '*.github.com'],
        },
      ]),
    });
    await pipeline.reload();
    masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
  });

  it('decodes Basic, unmasks password, re-encodes when domain allowed', async () => {
    const b64 = btoa(`x-access-token:${masked}`);
    const result = pipeline.unmaskAuthorizationBasic(`Basic ${b64}`, 'github.com');
    expect(typeof result).toBe('object');
    expect((result as { value: string }).value).toMatch(/^Basic /);
    const decoded = atob((result as { value: string }).value.replace(/^Basic /, ''));
    expect(decoded).toBe('x-access-token:ghp_realToken123');
  });

  it('forbids when domain not allowed', async () => {
    const b64 = btoa(`u:${masked}`);
    const result = pipeline.unmaskAuthorizationBasic(`Basic ${b64}`, 'evil.example.com');
    expect((result as { forbidden: ForbiddenInfo }).forbidden).toEqual({
      secretName: 'GITHUB_TOKEN',
      hostname: 'evil.example.com',
    });
  });

  it('leaves unchanged on invalid base64 / no colon / no mask', async () => {
    expect(pipeline.unmaskAuthorizationBasic('Basic %%%not-b64%%%', 'github.com')).toEqual({
      value: 'Basic %%%not-b64%%%',
    });
    expect(pipeline.unmaskAuthorizationBasic(`Basic ${btoa('nocolon')}`, 'github.com')).toEqual({
      value: `Basic ${btoa('nocolon')}`,
    });
    expect(pipeline.unmaskAuthorizationBasic(`Basic ${btoa('u:plain')}`, 'github.com')).toEqual({
      value: `Basic ${btoa('u:plain')}`,
    });
  });
});

describe('extractAndUnmaskUrlCredentials', () => {
  let pipeline: SecretsPipeline;
  let masked: string;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        { name: 'GITHUB_TOKEN', value: 'ghp_realToken123', domains: ['github.com'] },
      ]),
    });
    await pipeline.reload();
    masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
  });

  it('strips userinfo and synthesizes Authorization when password is masked', () => {
    const url = `https://x-access-token:${masked}@github.com/owner/repo.git`;
    const result = pipeline.extractAndUnmaskUrlCredentials(url);
    expect(result.url).toBe('https://github.com/owner/repo.git');
    expect(result.syntheticAuthorization).toBeDefined();
    const decoded = atob(result.syntheticAuthorization!.replace(/^Basic /, ''));
    expect(decoded).toBe('x-access-token:ghp_realToken123');
  });

  it('forbids when URL host is not allowed for the secret', () => {
    const result = pipeline.extractAndUnmaskUrlCredentials(`https://u:${masked}@evil.example.com/`);
    expect(result.forbidden).toEqual({ secretName: 'GITHUB_TOKEN', hostname: 'evil.example.com' });
  });

  it('strips userinfo even when no mask matches (browsers reject userinfo URLs)', () => {
    const result = pipeline.extractAndUnmaskUrlCredentials('https://u:plain@github.com/');
    expect(result.url).toBe('https://github.com/');
    expect(result.syntheticAuthorization).toBeUndefined();
  });

  it('returns url unchanged when no userinfo present', () => {
    const result = pipeline.extractAndUnmaskUrlCredentials('https://github.com/foo');
    expect(result.url).toBe('https://github.com/foo');
    expect(result.syntheticAuthorization).toBeUndefined();
  });

  it('returns url unchanged on malformed URL', () => {
    const result = pipeline.extractAndUnmaskUrlCredentials('not a url');
    expect(result.url).toBe('not a url');
  });
});

describe('unmaskBodyBytes — byte-safe', () => {
  let pipeline: SecretsPipeline;
  let masked: string;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        { name: 'GITHUB_TOKEN', value: 'ghp_realToken123', domains: ['github.com'] },
      ]),
    });
    await pipeline.reload();
    masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
  });

  it('replaces masked → real in a UTF-8 body', () => {
    const body = new TextEncoder().encode(`hello ${masked} world`);
    const { bytes } = pipeline.unmaskBodyBytes(body, 'github.com');
    expect(new TextDecoder().decode(bytes)).toBe('hello ghp_realToken123 world');
  });

  it('does not corrupt surrounding bytes when no match', () => {
    const before = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xc3, 0x28, 0xa0, 0x80]);
    const { bytes } = pipeline.unmaskBodyBytes(before, 'github.com');
    expect(Array.from(bytes)).toEqual(Array.from(before));
  });

  it('replaces only at byte-aligned masked-value occurrences', () => {
    const maskedBytes = new TextEncoder().encode(masked);
    const prefix = new Uint8Array([0xff, 0xfe, 0x00]);
    const suffix = new Uint8Array([0x01, 0xff]);
    const input = new Uint8Array(prefix.length + maskedBytes.length + suffix.length);
    input.set(prefix, 0);
    input.set(maskedBytes, prefix.length);
    input.set(suffix, prefix.length + maskedBytes.length);
    const { bytes } = pipeline.unmaskBodyBytes(input, 'github.com');
    const realBytes = new TextEncoder().encode('ghp_realToken123');
    const expected = new Uint8Array(prefix.length + realBytes.length + suffix.length);
    expected.set(prefix, 0);
    expected.set(realBytes, prefix.length);
    expected.set(suffix, prefix.length + realBytes.length);
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  it('leaves bytes untouched on domain mismatch', () => {
    const body = new TextEncoder().encode(`hello ${masked} world`);
    const { bytes } = pipeline.unmaskBodyBytes(body, 'evil.example.com');
    expect(new TextDecoder().decode(bytes)).toBe(`hello ${masked} world`);
  });
});

describe('scrubResponseBytes', () => {
  let pipeline: SecretsPipeline;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        { name: 'GITHUB_TOKEN', value: 'ghp_realToken123', domains: ['github.com'] },
      ]),
    });
    await pipeline.reload();
  });

  it('replaces real → masked at byte boundaries in a UTF-8 chunk', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const input = new TextEncoder().encode('hello ghp_realToken123 world');
    const out = pipeline.scrubResponseBytes(input);
    expect(new TextDecoder().decode(out)).toBe(`hello ${masked} world`);
  });

  it('leaves arbitrary non-UTF-8 bytes untouched', () => {
    const before = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xc3, 0x28, 0xa0, 0x80]);
    const out = pipeline.scrubResponseBytes(before);
    expect(Array.from(out)).toEqual(Array.from(before));
  });
});

describe('SecretsPipeline minimum-length guard', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('MIN_MASKABLE_SECRET_LENGTH is pinned to 9', () => {
    expect(MIN_MASKABLE_SECRET_LENGTH).toBe(9);
  });

  it('does NOT register an 8-char value as a masked entry and emits a warning naming the secret (not the value)', async () => {
    const pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        { name: 'SHORT_TOKEN', value: 'eightCHR', domains: ['api.github.com'] }, // 8 chars
      ]),
    });
    await pipeline.reload();

    expect(pipeline.hasSecrets()).toBe(false);
    expect(pipeline.getMaskedEntries()).toHaveLength(0);

    // Warning fired exactly once and names the secret without leaking the value
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain('SHORT_TOKEN');
    expect(msg).not.toContain('eightCHR');
  });

  it('an 8-char value cannot produce a forbidden/403 on any domain (not registered, so domain check never runs)', async () => {
    const pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([{ name: 'SHORT_TOKEN', value: 'eightCHR', domains: ['api.github.com'] }]),
    });
    await pipeline.reload();

    // The raw 8-char value passes through unmask() untouched — no forbidden.
    const headers: Record<string, string> = { authorization: 'Bearer eightCHR' };
    const result = pipeline.unmaskHeaders(headers, 'totally.unrelated.example.com');
    expect(result.forbidden).toBeUndefined();
    expect(headers.authorization).toBe('Bearer eightCHR');

    // Scrubber leaves the raw bytes alone as well.
    expect(pipeline.scrubResponse('value=eightCHR end')).toBe('value=eightCHR end');
  });

  it('a 9-char value still masks, unmasks, and domain-checks normally (no warning)', async () => {
    const pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        { name: 'NINE_TOKEN', value: 'nineChars', domains: ['api.github.com'] }, // 9 chars
      ]),
    });
    await pipeline.reload();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(pipeline.hasSecrets()).toBe(true);
    expect(pipeline.getMaskedEntries()).toHaveLength(1);

    const masked = await pipeline.maskOne('NINE_TOKEN', 'nineChars');
    const allowed: Record<string, string> = { authorization: `Bearer ${masked}` };
    expect(pipeline.unmaskHeaders(allowed, 'api.github.com').forbidden).toBeUndefined();
    expect(allowed.authorization).toBe('Bearer nineChars');

    const blocked: Record<string, string> = { authorization: `Bearer ${masked}` };
    expect(pipeline.unmaskHeaders(blocked, 'evil.example.com').forbidden).toEqual({
      secretName: 'NINE_TOKEN',
      hostname: 'evil.example.com',
    });
  });

  it('mixed batch: 8-char is skipped (with warning), 9-char is kept', async () => {
    const pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        { name: 'SHORT_TOKEN', value: '12345678', domains: ['api.github.com'] }, // 8 chars
        { name: 'LONG_TOKEN', value: 'ghp_real9', domains: ['api.github.com'] }, // 9 chars
      ]),
    });
    await pipeline.reload();

    const entries = pipeline.getMaskedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('LONG_TOKEN');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain('SHORT_TOKEN');
    expect(msg).not.toContain('12345678');
  });
});
