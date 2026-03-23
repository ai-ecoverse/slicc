import type { TurnIceServer } from './tray-signaling.js';

interface CloudflareTurnResponse {
  iceServers: TurnIceServer;
}

export const TURN_CREDENTIAL_TTL_SECONDS = 86_400;
export const TURN_CREDENTIAL_TTL_MS = TURN_CREDENTIAL_TTL_SECONDS * 1000;

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
    data.iceServers,
  ];
}
