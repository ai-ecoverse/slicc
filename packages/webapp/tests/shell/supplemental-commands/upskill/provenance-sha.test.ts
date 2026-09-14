import { describe, expect, it, vi } from 'vitest';
import { resolveCommitSha } from '../../../../src/shell/supplemental-commands/upskill/provenance.js';
import type { GitHubRequestContext } from '../../../../src/shell/supplemental-commands/upskill/types.js';
import { response } from './test-helpers.js';

function github(request: GitHubRequestContext['request'], hasToken = false): GitHubRequestContext {
  return { hasToken, request };
}

describe('resolveCommitSha', () => {
  it('resolves a path to the latest commit that touched it', async () => {
    const request = vi.fn(async (url: string) => {
      expect(url).toContain('/commits?');
      expect(url).toContain('path=skills%2Ffirefly');
      expect(url).toContain('sha=main');
      return response(200, JSON.stringify([{ sha: '3f23c29aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]));
    });
    const sha = await resolveCommitSha(
      'ai-ecoverse',
      'skills',
      'main',
      github(request),
      true,
      'skills/firefly'
    );
    expect(sha).toBe('3f23c29aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('resolves a ref head when no path is given', async () => {
    const request = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.github.com/repos/ai-ecoverse/skills/commits/main');
      return response(200, JSON.stringify({ sha: 'abebd04bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }));
    });
    const sha = await resolveCommitSha('ai-ecoverse', 'skills', 'main', github(request), true);
    expect(sha).toBe('abebd04bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('returns undefined without a token unless allowAnonymous is set', async () => {
    const request = vi.fn();
    await expect(
      resolveCommitSha('ai-ecoverse', 'skills', 'main', github(request, false), false)
    ).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});
