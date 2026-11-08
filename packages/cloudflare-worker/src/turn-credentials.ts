import type { TurnIceServer } from '@slicc/shared-ts';

/** Cloudflare TURN over TLS on 443 — works on networks that reset 5349. */
export const TURN_TLS_443_URL = 'turns:turn.cloudflare.com:443?transport=tcp';

interface CloudflareTurnIceServer {
  urls: string | string[];
  username: string;
  credential: string;
}

interface CloudflareTurnResponse {
  iceServers: CloudflareTurnIceServer;
}

export const TURN_CREDENTIAL_TTL_SECONDS = 86_400;
export const TURN_CREDENTIAL_TTL_MS = TURN_CREDENTIAL_TTL_SECONDS * 1000;

function withTurnTls443(server: CloudflareTurnIceServer): TurnIceServer {
  const existing = Array.isArray(server.urls) ? server.urls : [server.urls];
  const urls = existing.includes(TURN_TLS_443_URL)
    ? [...existing]
    : [...existing, TURN_TLS_443_URL];
  return {
    urls,
    username: server.username,
    credential: server.credential,
  };
}

export async function fetchTURNCredentials(
  keyId: string,
  apiToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<TurnIceServer[]> {
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
  });

  if (!response.ok) {
    throw new Error(`TURN credential request failed (${response.status})`);
  }

  const data = (await response.json()) as CloudflareTurnResponse;
  return [
    { urls: ['stun:stun.cloudflare.com:3478'], username: '', credential: '' },
    withTurnTls443(data.iceServers),
  ];
}
