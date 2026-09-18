import { describe, expect, it, vi } from 'vitest';
import { parseRepository } from './merge-queue-busy.mjs';
import {
  fetchMergeQueueEntryCount,
  isGithubRateLimitError,
  parseMergeQueueEntryCount,
  rateLimitBackoffMs,
  shouldMutateCloudflareStaging,
} from './merge-queue-lib.mjs';

describe('shouldMutateCloudflareStaging', () => {
  it('runs for trusted pull requests', () => {
    expect(
      shouldMutateCloudflareStaging({
        eventName: 'pull_request',
        isForkPr: false,
        isQueueLeader: false,
        isStacked: false,
      })
    ).toBe(true);
  });

  it('skips fork pull requests', () => {
    expect(
      shouldMutateCloudflareStaging({
        eventName: 'pull_request',
        isForkPr: true,
        isQueueLeader: true,
      })
    ).toBe(false);
  });

  it('skips Dependabot-triggered pull requests', () => {
    expect(
      shouldMutateCloudflareStaging({
        eventName: 'pull_request',
        isForkPr: false,
        isDependabot: true,
        isQueueLeader: true,
      })
    ).toBe(false);
  });

  it('runs only for the merge_group queue leader', () => {
    expect(
      shouldMutateCloudflareStaging({
        eventName: 'merge_group',
        isQueueLeader: true,
        isStacked: false,
      })
    ).toBe(true);
    expect(
      shouldMutateCloudflareStaging({
        eventName: 'merge_group',
        isQueueLeader: false,
      })
    ).toBe(false);
  });

  it('runs for ordinary push events', () => {
    expect(shouldMutateCloudflareStaging({ eventName: 'push', isStacked: false })).toBe(true);
  });

  it('skips stacked pull requests', () => {
    expect(
      shouldMutateCloudflareStaging({
        eventName: 'pull_request',
        isForkPr: false,
        isStacked: true,
        isQueueLeader: true,
      })
    ).toBe(false);
    expect(
      shouldMutateCloudflareStaging({
        eventName: 'pull_request',
        isForkPr: false,
        isStacked: 'true',
        isQueueLeader: true,
      })
    ).toBe(false);
  });

  it('skips mutation when the stacked output is missing, empty, or garbage', () => {
    const trusted = {
      eventName: 'pull_request',
      isForkPr: false,
      isQueueLeader: true,
    };
    expect(shouldMutateCloudflareStaging(trusted)).toBe(false);
    expect(shouldMutateCloudflareStaging({ ...trusted, isStacked: undefined })).toBe(false);
    expect(shouldMutateCloudflareStaging({ ...trusted, isStacked: '' })).toBe(false);
    expect(shouldMutateCloudflareStaging({ ...trusted, isStacked: 'garbage' })).toBe(false);
    expect(shouldMutateCloudflareStaging({ ...trusted, isStacked: 'FALSE' })).toBe(false);
    expect(shouldMutateCloudflareStaging({ ...trusted, isStacked: 'false' })).toBe(true);
  });
});

describe('parseMergeQueueEntryCount', () => {
  it('reads totalCount', () => {
    expect(
      parseMergeQueueEntryCount({
        data: { repository: { mergeQueue: { entries: { totalCount: 11 } } } },
      })
    ).toBe(11);
  });

  it('treats a null mergeQueue as idle', () => {
    expect(parseMergeQueueEntryCount({ data: { repository: { mergeQueue: null } } })).toBe(0);
  });

  it('rejects malformed payloads', () => {
    expect(() => parseMergeQueueEntryCount({ data: { repository: {} } })).toThrow(/Unexpected/);
  });
});

describe('isGithubRateLimitError / rateLimitBackoffMs', () => {
  it('detects installation rate-limit messages', () => {
    expect(isGithubRateLimitError(new Error('API rate limit exceeded for installation'))).toBe(
      true
    );
    expect(isGithubRateLimitError(new Error('ENOTFOUND'))).toBe(false);
  });

  it('backs off exponentially', () => {
    expect(rateLimitBackoffMs(1)).toBe(5000);
    expect(rateLimitBackoffMs(2)).toBe(15000);
    expect(rateLimitBackoffMs(3)).toBe(45000);
  });
});

describe('fetchMergeQueueEntryCount', () => {
  it('returns the entry count on success', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: { repository: { mergeQueue: { entries: { totalCount: 3 } } } },
        }),
      json: async () => ({}),
    }));

    await expect(
      fetchMergeQueueEntryCount({
        owner: 'ai-ecoverse',
        repo: 'slicc',
        token: 't',
        fetchImpl,
      })
    ).resolves.toBe(3);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries rate-limit responses then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'API rate limit exceeded for installation',
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: { repository: { mergeQueue: { entries: { totalCount: 0 } } } },
          }),
        json: async () => ({}),
      });

    await expect(
      fetchMergeQueueEntryCount({
        owner: 'ai-ecoverse',
        repo: 'slicc',
        token: 't',
        fetchImpl,
        sleep,
        maxAttempts: 3,
      })
    ).resolves.toBe(0);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('parseRepository', () => {
  it('splits owner/repo', () => {
    expect(parseRepository('ai-ecoverse/slicc')).toEqual({
      owner: 'ai-ecoverse',
      repo: 'slicc',
    });
  });

  it('rejects bad values', () => {
    expect(() => parseRepository('noslash')).toThrow(/owner\/repo/);
  });
});
