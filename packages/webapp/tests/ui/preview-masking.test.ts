import { describe, it, expect } from 'vitest';
import { maskSecrets } from '../../src/ui/preview-masking.js';

// Use synthetic tokens that look like real secrets but won't trigger
// GitHub secret scanning (length/prefix combos that don't match real PATs).
const FAKE_GHP = 'ghp_' + 'Abc123Xyz456Abc123Xyz456Abc123Xyz456';
const FAKE_GHO = 'gho_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
const FAKE_GHS = 'ghs_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
const FAKE_HEX = 'bbd8ba177e3fb597355c4c3054ddb3b7d1ea27cf';

describe('maskSecrets()', () => {
  // ── env-var assignments with secret-looking names ─────────────────
  describe('env-var assignments', () => {
    it('masks TOKEN=value', () => {
      expect(maskSecrets(`TOKEN=${FAKE_GHP}`)).toBe('TOKEN=***');
    });

    it('masks GITHUB_TOKEN=value', () => {
      expect(maskSecrets('GITHUB_TOKEN=ghp_abc123456789xyzABCDEF')).toBe('GITHUB_TOKEN=***');
    });

    it('masks API_KEY=value', () => {
      expect(maskSecrets('export API_KEY=sk-ant-abc123456789')).toBe('export API_KEY=***');
    });

    it('masks SECRET=value', () => {
      expect(maskSecrets('MY_SECRET=supersecretvalue1234')).toBe('MY_SECRET=***');
    });

    it('masks PASSWORD=value', () => {
      expect(maskSecrets('DB_PASSWORD=hunter2_but_longer!')).toBe('DB_PASSWORD=***');
    });

    it('masks ACCESS_TOKEN=value', () => {
      expect(maskSecrets('ACCESS_TOKEN=eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBe('ACCESS_TOKEN=***');
    });

    it('masks AUTH=value', () => {
      expect(maskSecrets('MY_AUTH=some_long_auth_value_here')).toBe('MY_AUTH=***');
    });

    it('masks BEARER=value', () => {
      expect(maskSecrets('BEARER=some_bearer_token_value')).toBe('BEARER=***');
    });

    it('is case insensitive for key names', () => {
      expect(maskSecrets('token=abcdefghijklmnop')).toBe('token=***');
    });

    it('does not mask short values (< 8 chars)', () => {
      expect(maskSecrets('TOKEN=short')).toBe('TOKEN=short');
    });

    it('handles colon separator', () => {
      expect(maskSecrets('SECRET: myverylongsecretvalue')).toBe('SECRET: ***');
    });

    it('masks double-quoted values', () => {
      expect(maskSecrets(`export API_KEY="sk-ant-abcdefghijk"`)).toBe('export API_KEY="***"');
    });

    it('masks single-quoted values', () => {
      expect(maskSecrets(`TOKEN='supersecretvalue123'`)).toBe("TOKEN='***'");
    });

    it('masks double-quoted values with spaces inside', () => {
      expect(maskSecrets(`PASSWORD="my long pass phrase"`)).toBe('PASSWORD="***"');
    });

    it('does not mask short quoted values', () => {
      expect(maskSecrets('TOKEN="short"')).toBe('TOKEN="short"');
    });
  });

  // ── Authorization: Bearer header ──────────────────────────────────
  describe('Authorization Bearer header', () => {
    it('masks Authorization: Bearer <token>', () => {
      expect(maskSecrets(`Authorization: Bearer ${FAKE_GHP}`)).toBe('Authorization: Bearer ***');
    });

    it('masks with varying whitespace', () => {
      expect(maskSecrets('Authorization:  Bearer  sk-ant-abcdefghijk')).toBe(
        'Authorization:  Bearer  ***'
      );
    });

    it('does not mask short Bearer values', () => {
      expect(maskSecrets('Authorization: Bearer short')).toBe('Authorization: Bearer short');
    });
  });

  // ── long random-looking strings ───────────────────────────────────
  describe('long random-looking strings', () => {
    it('masks GitHub PAT ghp_ tokens', () => {
      expect(maskSecrets(`using ${FAKE_GHP} here`)).toBe('using *** here');
    });

    it('masks GitHub gho_ tokens', () => {
      expect(maskSecrets(FAKE_GHO)).toBe('***');
    });

    it('masks GitHub ghs_ tokens', () => {
      expect(maskSecrets(FAKE_GHS)).toBe('***');
    });

    it('masks 40-char hex hashes', () => {
      expect(maskSecrets(`commit ${FAKE_HEX} done`)).toBe('commit *** done');
    });

    it('masks uppercase hex hashes', () => {
      const upperHex = 'BBD8BA177E3FB597355C4C3054DDB3B7D1EA27CF';
      expect(maskSecrets(`commit ${upperHex} done`)).toBe('commit *** done');
    });

    it('masks long alphanumeric strings (40+ chars)', () => {
      const longStr = 'A'.repeat(45);
      expect(maskSecrets(`value=${longStr}`)).toBe('value=***');
    });

    it('masks base64-ish strings with trailing = padding', () => {
      const b64 = 'A'.repeat(40) + '==';
      expect(maskSecrets(`payload ${b64} end`)).toBe('payload *** end');
    });

    it('does not mask normal text', () => {
      const text = '$ echo "hello world"';
      expect(maskSecrets(text)).toBe(text);
    });

    it('does not mask short strings', () => {
      const text = '$ ls -la /tmp';
      expect(maskSecrets(text)).toBe(text);
    });
  });

  // ── combined / realistic examples ─────────────────────────────────
  describe('realistic bash previews', () => {
    it('masks curl with Authorization header', () => {
      const input = `$ curl -H "Authorization: Bearer ${FAKE_GHP}" https://api.github.com/user`;
      const expected = '$ curl -H "Authorization: Bearer ***" https://api.github.com/user';
      expect(maskSecrets(input)).toBe(expected);
    });

    it('masks env var export in a command', () => {
      const input = `$ export GITHUB_TOKEN=${FAKE_GHP} && git push`;
      const expected = '$ export GITHUB_TOKEN=*** && git push';
      expect(maskSecrets(input)).toBe(expected);
    });

    it('preserves non-secret commands', () => {
      const input = '$ cd /shared/slicc-masking && rg "tool-call" src/';
      expect(maskSecrets(input)).toBe(input);
    });

    it('preserves simple git commands', () => {
      const input = '$ git checkout -b feat/my-feature';
      expect(maskSecrets(input)).toBe(input);
    });
  });

  // ── edge cases ────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(maskSecrets('')).toBe('');
    });

    it('handles string with no matches', () => {
      const text = 'just some normal text here';
      expect(maskSecrets(text)).toBe(text);
    });

    it('handles multiple secrets in one string', () => {
      const input = 'TOKEN=abcdefghijk SECRET=xyzxyzxyzxyz';
      expect(maskSecrets(input)).toBe('TOKEN=*** SECRET=***');
    });
  });
});
