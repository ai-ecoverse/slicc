import { redactCredentialPatterns } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';

describe('redactCredentialPatterns', () => {
  it('redacts deterministic credential patterns without generic entropy matching', () => {
    const input = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature sha256=abcdef123456';
    const result = redactCredentialPatterns(input, 'r');
    expect(result.text).toContain('⟦REDACTED:jwt:r1⟧');
    expect(result.text).toContain('sha256=abcdef123456');
    expect(result.matches).toEqual([{ id: 'r1', category: 'jwt' }]);
  });

  it('redacts API key prefix patterns', () => {
    const result = redactCredentialPatterns('config sk-live-abcdefghij', 'r');
    expect(result.text).toContain('⟦REDACTED:api-key:r1⟧');
    expect(result.matches).toEqual([{ id: 'r1', category: 'api-key' }]);
  });

  it('redacts raw Anthropic sk-ant- API keys', () => {
    const result = redactCredentialPatterns('key: sk-ant-api03-abcdefghijklmnop', 'r');
    expect(result.text).toContain('⟦REDACTED:api-key:r1⟧');
    expect(result.text).not.toContain('sk-ant-');
    expect(result.matches).toEqual([{ id: 'r1', category: 'api-key' }]);
  });

  it('redacts password assignment patterns', () => {
    const result = redactCredentialPatterns('password=hunter2', 'r');
    expect(result.text).toContain('⟦REDACTED:password:r1⟧');
    expect(result.matches).toEqual([{ id: 'r1', category: 'password' }]);
  });

  it('preserves existing ⟦REDACTED:⟧ markers without re-matching their content', () => {
    const input = '⟦REDACTED:known-secret:k1⟧ extra text';
    const result = redactCredentialPatterns(input, 'r');
    expect(result.text).toContain('⟦REDACTED:known-secret:k1⟧');
    expect(result.matches).toHaveLength(0);
  });

  it('uses firstId to continue numbering', () => {
    const result = redactCredentialPatterns('password=secret1', 'p', 5);
    expect(result.matches[0]?.id).toBe('p5');
    expect(result.nextId).toBe(6);
  });

  it('returns unchanged text and empty matches for plain text', () => {
    const result = redactCredentialPatterns('Hello, world!', 'r');
    expect(result.text).toBe('Hello, world!');
    expect(result.matches).toHaveLength(0);
    expect(result.nextId).toBe(1);
  });

  it('redacts PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const result = redactCredentialPatterns(pem, 'r');
    expect(result.text).toContain('⟦REDACTED:private-key:r1⟧');
    expect(result.matches).toEqual([{ id: 'r1', category: 'private-key' }]);
  });

  it('JWT wins over bearer-token when both could match', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
    const result = redactCredentialPatterns(`Authorization: Bearer ${jwt}`, 'r');
    // JWT should be matched (not bearer-token, which would overlap)
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.category).toBe('jwt');
  });

  it('chains multiple matches with stable IDs', () => {
    const result = redactCredentialPatterns('password=a token=b', 'r');
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]?.id).toBe('r1');
    expect(result.matches[1]?.id).toBe('r2');
    expect(result.nextId).toBe(3);
  });
});
