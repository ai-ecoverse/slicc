import { describe, it, expect, beforeEach } from 'vitest';
import {
  SecretsPipeline,
  type FetchProxySecretSource,
  type ForbiddenInfo,
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
    const b64 = Buffer.from(`x-access-token:${masked}`, 'utf-8').toString('base64');
    const result = pipeline.unmaskAuthorizationBasic(`Basic ${b64}`, 'github.com');
    expect(typeof result).toBe('object');
    expect((result as { value: string }).value).toMatch(/^Basic /);
    const decoded = Buffer.from(
      (result as { value: string }).value.replace(/^Basic /, ''),
      'base64'
    ).toString('utf-8');
    expect(decoded).toBe('x-access-token:ghp_realToken123');
  });

  it('forbids when domain not allowed', async () => {
    const b64 = Buffer.from(`u:${masked}`, 'utf-8').toString('base64');
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
    expect(
      pipeline.unmaskAuthorizationBasic(
        `Basic ${Buffer.from('nocolon').toString('base64')}`,
        'github.com'
      )
    ).toEqual({ value: `Basic ${Buffer.from('nocolon').toString('base64')}` });
    expect(
      pipeline.unmaskAuthorizationBasic(
        `Basic ${Buffer.from('u:plain').toString('base64')}`,
        'github.com'
      )
    ).toEqual({ value: `Basic ${Buffer.from('u:plain').toString('base64')}` });
  });
});
