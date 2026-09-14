import { describe, expect, it } from 'vitest';
import { determineReleaseType, parseGitLog } from './release-plan.mjs';

describe('parseGitLog', () => {
  it('maps delimited git records to semantic-release commits', () => {
    expect(parseGitLog('abc\x1ffeat: add gating\n\x1e\ndef\x1fchore: docs\n\x1e')).toEqual([
      { hash: 'abc', message: 'feat: add gating' },
      { hash: 'def', message: 'chore: docs' },
    ]);
  });

  it('rejects malformed records', () => {
    expect(() => parseGitLog('missing separator\x1e')).toThrow('Malformed git log record');
  });
});

describe('determineReleaseType', () => {
  it('uses semantic-release default rules without repository authentication', async () => {
    await expect(determineReleaseType([{ hash: 'a', message: 'feat: add gating' }])).resolves.toBe(
      'minor'
    );
    await expect(
      determineReleaseType([{ hash: 'b', message: 'fix: repair gating' }])
    ).resolves.toBe('patch');
    await expect(
      determineReleaseType([{ hash: 'c', message: 'chore: update docs' }])
    ).resolves.toBeNull();
  });
});
