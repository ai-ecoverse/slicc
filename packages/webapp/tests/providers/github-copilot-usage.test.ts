import { describe, expect, it, vi } from 'vitest';
import {
  COPILOT_USER_URL,
  fetchCopilotUsage,
  parseCopilotUsage,
  type UsageFetch,
} from '../../src/providers/github-copilot-usage.js';

const OK_BODY = {
  quota_reset_date_utc: '2026-10-01T00:00:00.000Z',
  quota_snapshots: {
    chat: { unlimited: true },
    completions: { unlimited: true },
    premium_interactions: {
      unlimited: false,
      percent_remaining: 95.6,
      overage_permitted: true,
    },
  },
};

function respond(status: number, body: unknown = {}): UsageFetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe('parseCopilotUsage', () => {
  it('reads the premium_interactions window as percent USED', () => {
    const window = parseCopilotUsage(OK_BODY);
    expect(window?.percent).toBeCloseTo(4.4);
    expect(window).toMatchObject({
      status: 'ok',
      window: 'monthly',
      resetsAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('reports rate-limited once the account has none left and no overage', () => {
    const window = parseCopilotUsage({
      quota_snapshots: {
        premium_interactions: { unlimited: false, percent_remaining: 0, overage_permitted: false },
      },
    });
    expect(window).toMatchObject({ percent: 100, status: 'rate-limited' });
  });

  it('reports NO WINDOW for an unlimited plan', () => {
    expect(
      parseCopilotUsage({
        quota_snapshots: { premium_interactions: { unlimited: true, percent_remaining: 100 } },
      })
    ).toBeNull();
  });

  it('reports no window for a shape it does not recognize', () => {
    expect(parseCopilotUsage({})).toBeNull();
    expect(parseCopilotUsage({ quota_snapshots: {} })).toBeNull();
    expect(parseCopilotUsage(null)).toBeNull();
  });
});

describe('fetchCopilotUsage', () => {
  it('calls copilot_internal/user with the GitHub access token', async () => {
    const fetchImpl = respond(200, OK_BODY);
    const window = await fetchCopilotUsage('gh-token', fetchImpl);

    expect(window?.percent).toBeCloseTo(4.4);
    expect(window).toMatchObject({ status: 'ok', window: 'monthly' });
    expect(fetchImpl).toHaveBeenCalledWith(
      COPILOT_USER_URL,
      expect.objectContaining({ headers: { Authorization: 'Bearer gh-token' } })
    );
  });

  it('merges caller headers without letting them shadow the credential', async () => {
    const fetchImpl = respond(200, OK_BODY);
    await fetchCopilotUsage('gh-token', fetchImpl, { headers: { 'Editor-Version': 'vscode/1' } });
    expect(fetchImpl).toHaveBeenCalledWith(
      COPILOT_USER_URL,
      expect.objectContaining({
        headers: { 'Editor-Version': 'vscode/1', Authorization: 'Bearer gh-token' },
      })
    );
  });

  it('THROWS on a refused or broken call so the retry clock stays short', async () => {
    await expect(fetchCopilotUsage('t', respond(401))).rejects.toThrow('401');
    await expect(fetchCopilotUsage('t', respond(503))).rejects.toThrow('503');
  });

  it('reports no window for a 200 that carries nothing parseable', async () => {
    await expect(fetchCopilotUsage('t', respond(200, {}))).resolves.toBeNull();
  });

  it('reports no window for a 404/501 instead of throwing (retired or unsupported endpoint)', async () => {
    await expect(fetchCopilotUsage('t', respond(404))).resolves.toBeNull();
    await expect(fetchCopilotUsage('t', respond(501))).resolves.toBeNull();
  });

  it('propagates a transport failure rather than swallowing it', async () => {
    const fetchImpl: UsageFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(fetchCopilotUsage('t', fetchImpl)).rejects.toThrow('network down');
  });

  it('aborts a call that never answers', async () => {
    let aborted = false;
    const fetchImpl: UsageFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    await expect(fetchCopilotUsage('t', fetchImpl, { timeoutMs: 5 })).rejects.toThrow('aborted');
    expect(aborted).toBe(true);
  });
});
