import { describe, expect, it, vi } from 'vitest';
import { fetchTURNCredentials } from './turn-credentials.js';

describe('turn-credentials', () => {
  it('fetches TURN credentials and prepends a STUN server', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({
        iceServers: {
          urls: ['turn:turn.example.com:3478?transport=udp'],
          username: 'test-user',
          credential: 'test-credential',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const result = await fetchTURNCredentials('key-id', 'api-token', mockFetch);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Authorization': 'Bearer api-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),
      }),
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      urls: ['stun:stun.cloudflare.com:3478'],
      username: '',
      credential: '',
    });
    expect(result[1]).toEqual({
      urls: ['turn:turn.example.com:3478?transport=udp'],
      username: 'test-user',
      credential: 'test-credential',
    });
  });

  it('throws when the API returns a non-OK status', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    await expect(fetchTURNCredentials('key-id', 'bad-token', mockFetch))
      .rejects.toThrow('TURN credential request failed (401)');
  });
});
