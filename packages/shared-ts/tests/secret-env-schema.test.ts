import { describe, expect, it } from 'vitest';
import {
  deriveS3Domains,
  PROFILE_RE,
  pairEnvEntriesToSecrets,
  parseDomainsCsv,
  parseEnvFile,
  parseEnvFilePreservingValues,
  serializeEnvFile,
  validateS3ProfileInput,
} from '../src/secret-env-schema.js';

describe('parseDomainsCsv', () => {
  it.each([
    ['a, b', ['a', 'b']],
    ['a,', ['a']],
    ['a,,b', ['a', 'b']],
    ['  , \t,', []],
  ])('normalizes %j', (raw, expected) => {
    expect(parseDomainsCsv(raw)).toEqual(expected);
  });
});

describe('pairEnvEntriesToSecrets', () => {
  it('pairs values with domain companions and drops incomplete pairs', () => {
    expect(
      pairEnvEntriesToSecrets([
        { key: 'TOKEN', value: 'old' },
        { key: 'ORPHAN', value: 'ignored' },
        { key: 'TOKEN_DOMAINS', value: 'api.example.com, *.example.com' },
        { key: 'TOKEN', value: 'new' },
        { key: 'EMPTY', value: 'ignored' },
        { key: 'EMPTY_DOMAINS', value: ' ,' },
      ])
    ).toEqual([
      {
        name: 'TOKEN',
        value: 'new',
        domains: ['api.example.com', '*.example.com'],
      },
    ]);
  });

  it('uses the shared env parser without truncating values containing equals signs', () => {
    expect(
      pairEnvEntriesToSecrets(parseEnvFile('JWT=aa.bb==\nJWT_DOMAINS=a.test, b.test'))
    ).toEqual([{ name: 'JWT', value: 'aa.bb==', domains: ['a.test', 'b.test'] }]);
  });
});

describe('env file format', () => {
  it('parses the shared subset and skips non-entry lines', () => {
    expect(parseEnvFile(' # note\n\n BAD\n =empty-key\n A = "hello world" \nB=abc=def')).toEqual([
      { key: 'A', value: 'hello world' },
      { key: 'B', value: 'abc=def' },
    ]);
    expect(parseEnvFile("A='single quoted'")).toEqual([{ key: 'A', value: 'single quoted' }]);
  });

  it('can preserve raw values for verbatim secret formats', () => {
    expect(parseEnvFilePreservingValues(' # note\nA="quoted"\nB=  padded  \nBAD')).toEqual([
      { key: 'A', value: '"quoted"' },
      { key: 'B', value: '  padded  ' },
    ]);
  });

  it('serializes plain and escaped values', () => {
    expect(
      serializeEnvFile([
        { key: 'PLAIN', value: 'value' },
        { key: 'QUOTED', value: 'say "hello" #1' },
      ])
    ).toBe('PLAIN=value\nQUOTED="say \\"hello\\" #1"\n');
    expect(serializeEnvFile([])).toBe('\n');
  });
});

describe('S3 profile helpers', () => {
  it('derives domains for AWS, custom, and malformed endpoints', () => {
    expect(deriveS3Domains(undefined)).toEqual(['*.amazonaws.com']);
    expect(deriveS3Domains('https://account.r2.cloudflarestorage.com')).toEqual([
      '*.r2.cloudflarestorage.com',
    ]);
    expect(deriveS3Domains('https://localhost.test:9000')).toEqual(['localhost.test:9000']);
    expect(deriveS3Domains('not a URL')).toEqual(['*.amazonaws.com']);
  });

  it('validates required fields and resolves explicit domains', () => {
    expect(PROFILE_RE.test('prod.us-west_2')).toBe(true);
    expect(validateS3ProfileInput({ profile: 'bad name', accessKey: 'a', secretKey: 's' }).ok).toBe(
      false
    );
    expect(validateS3ProfileInput({ profile: 'aws', accessKey: '', secretKey: 's' }).ok).toBe(
      false
    );
    expect(validateS3ProfileInput({ profile: 'aws', accessKey: 'a', secretKey: '' }).ok).toBe(
      false
    );
    expect(
      validateS3ProfileInput({
        profile: 'aws',
        accessKey: 'a',
        secretKey: 's',
        domains: ['s3.example.com'],
      })
    ).toEqual({ ok: true, resolvedDomains: ['s3.example.com'] });
    expect(validateS3ProfileInput({ profile: 'aws', accessKey: 'a', secretKey: 's' })).toEqual({
      ok: true,
      resolvedDomains: ['*.amazonaws.com'],
    });
  });
});
