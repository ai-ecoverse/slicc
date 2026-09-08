import { describe, expect, it, vi } from 'vitest';
import { fetchAdobeUsage, type UsageFetch } from '../../src/providers/adobe-usage.js';

const OK_BODY = {
  usage: { weekly: { status: 'ok', percent: 9.5, resetsAt: '2026-09-14T00:00:00.000Z' } },
};

function respond(status: number, body: unknown = {}): UsageFetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe('fetchAdobeUsage', () => {
  it('calls /v1/usage with the IMS token and parses the window', async () => {
    const fetchImpl = respond(200, OK_BODY);
    const window = await fetchAdobeUsage('https://proxy.example.com', 'ims-token', fetchImpl);

    expect(window).toMatchObject({ percent: 9.5, status: 'ok', window: 'weekly' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://proxy.example.com/v1/usage',
      expect.objectContaining({ headers: { Authorization: 'Bearer ims-token' } })
    );
  });

  it('does not double the slash on an endpoint with a trailing one', async () => {
    const fetchImpl = respond(200, OK_BODY);
    await fetchAdobeUsage('https://proxy.example.com/', 'ims-token', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('https://proxy.example.com/v1/usage', expect.anything());
  });

  it('reports NO WINDOW for a proxy that does not implement the endpoint', async () => {
    // 404/501 is the endpoint answering, not failing: the caller writes the
    // provider off for half an hour rather than retrying in five minutes.
    await expect(fetchAdobeUsage('https://p', 't', respond(404))).resolves.toBeNull();
    await expect(fetchAdobeUsage('https://p', 't', respond(501))).resolves.toBeNull();
  });

  it('reports no window for a 200 that carries nothing parseable', async () => {
    await expect(
      fetchAdobeUsage('https://p', 't', respond(200, { usage: {} }))
    ).resolves.toBeNull();
  });

  it('THROWS on a refused or broken call so the retry clock stays short', async () => {
    await expect(fetchAdobeUsage('https://p', 't', respond(401))).rejects.toThrow('401');
    await expect(fetchAdobeUsage('https://p', 't', respond(503))).rejects.toThrow('503');
  });

  it('propagates a transport failure rather than swallowing it', async () => {
    const fetchImpl: UsageFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(fetchAdobeUsage('https://p', 't', fetchImpl)).rejects.toThrow('network down');
  });

  it('aborts a proxy that never answers', async () => {
    let aborted = false;
    const fetchImpl: UsageFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    await expect(fetchAdobeUsage('https://p', 't', fetchImpl, 5)).rejects.toThrow('aborted');
    expect(aborted).toBe(true);
  });
});
