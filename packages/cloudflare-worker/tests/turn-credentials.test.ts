import { describe, expect, it, vi } from 'vitest';
import { fetchTURNCredentials, TURN_TLS_443_URL } from '../src/turn-credentials.js';

describe('turn-credentials', () => {
  it('fetches TURN credentials, prepends STUN, and appends turns over TLS on 443', async () => {
    const iceServers = {
      urls: ['turn:turn.example.com:3478?transport=udp'],
      username: 'test-user',
      credential: 'test-credential',
    };
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ iceServers }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await fetchTURNCredentials('key-id', 'api-token', mockFetch);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer api-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),
      })
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      urls: ['stun:stun.cloudflare.com:3478'],
      username: '',
      credential: '',
    });
    expect(result[1]).toEqual({
      urls: ['turn:turn.example.com:3478?transport=udp', TURN_TLS_443_URL],
      username: 'test-user',
      credential: 'test-credential',
    });
    // Do not mutate the Cloudflare response object across calls.
    expect(iceServers.urls).toEqual(['turn:turn.example.com:3478?transport=udp']);
  });

  it('does not duplicate turns:443 when Cloudflare already returns it', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          iceServers: {
            urls: [
              'turn:turn.cloudflare.com:3478?transport=udp',
              TURN_TLS_443_URL,
              'turns:turn.cloudflare.com:5349?transport=tcp',
            ],
            username: 'user',
            credential: 'cred',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await fetchTURNCredentials('key-id', 'api-token', mockFetch);

    expect(result[1]).toEqual({
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        TURN_TLS_443_URL,
        'turns:turn.cloudflare.com:5349?transport=tcp',
      ],
      username: 'user',
      credential: 'cred',
    });
    expect(result[1]!.urls.filter((u) => u === TURN_TLS_443_URL)).toHaveLength(1);
  });

  it('normalizes a string urls field and appends turns over TLS on 443', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          iceServers: {
            urls: 'turn:turn.example.com:3478?transport=udp',
            username: 'string-user',
            credential: 'string-cred',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await fetchTURNCredentials('key-id', 'api-token', mockFetch);

    expect(result[1]).toEqual({
      urls: ['turn:turn.example.com:3478?transport=udp', TURN_TLS_443_URL],
      username: 'string-user',
      credential: 'string-cred',
    });
  });

  it('throws when the API returns a non-OK status', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    await expect(fetchTURNCredentials('key-id', 'bad-token', mockFetch)).rejects.toThrow(
      'TURN credential request failed (401)'
    );
  });
});
