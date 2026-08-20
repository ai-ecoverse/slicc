/**
 * APNs (Apple Push Notification service) sender for the tray hub (issue #2062).
 *
 * The tray DO wakes suspended iOS followers for two things: a finished turn
 * (`turn_end`, a normal banner) and a pending sudo approval (`sudo_request`,
 * a time-sensitive banner with Deny / Review actions). Payloads are metadata
 * only — scoop label, category, request id — never command text or transcript
 * content; the phone reconnects and fetches the real request over the data
 * channel.
 *
 * Auth is token-based (a `.p8` key): an ES256 JWT signed with WebCrypto,
 * cached for 50 minutes (Apple: refresh at least hourly, at most every 20
 * minutes). Missing secrets disable pushing entirely — the DO logs once and
 * treats every send as a no-op, so the rest of the tray never depends on APNs.
 *
 * APNs requires HTTP/2; Workers' `fetch` negotiates it with Apple's gateway.
 */

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** PEM-encoded PKCS#8 private key (the `.p8` file contents, newlines or `\n`). */
  privateKeyPem: string;
  /** The app's bundle id (`apns-topic`). */
  topic: string;
}

export type ApnsEnvironment = 'sandbox' | 'production';

export type PushCategory = 'turn_end' | 'sudo_request';

export interface ApnsPushRequest {
  token: string;
  environment: ApnsEnvironment;
  category: PushCategory;
  /** Human label for the banner (scoop name). */
  label: string;
  trayId: string;
  requestId?: string;
}

export interface ApnsPushResult {
  token: string;
  /** HTTP status from APNs, or 0 when the request itself failed. */
  status: number;
  /** APNs `reason` string when the gateway rejected the push. */
  reason?: string;
  /** True when the token is dead and must be forgotten (410 / BadDeviceToken). */
  dropToken: boolean;
}

/** Something that can deliver one push. The DO holds one; tests inject a fake. */
export interface ApnsSender {
  send(request: ApnsPushRequest): Promise<ApnsPushResult>;
}

/** The `aps` dictionary plus SLICC's own metadata — what the phone receives. */
export interface ApnsPayload {
  aps: {
    alert: { title: string; body: string };
    sound: 'default';
    category: string;
    'thread-id': string;
    'interruption-level': 'time-sensitive' | 'active';
    'relevance-score'?: number;
  };
  slicc: { category: PushCategory; trayId: string; requestId?: string };
}

/** Notification categories the iOS app registers (`NotificationCoordinator`). */
export const APNS_CATEGORY_IDS: Record<PushCategory, string> = {
  turn_end: 'SLICC_TURN_END',
  sudo_request: 'SLICC_SUDO_REQUEST',
};

const JWT_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
/** Sudo banners are pointless after the leader's 5-minute deadline. */
const SUDO_EXPIRY_SECONDS = 5 * 60;

/** Reasons that mean "this token will never work again". */
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
/** Reasons that mean "our JWT is bad; mint a fresh one and retry once". */
const STALE_JWT_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);

export function apnsHost(environment: ApnsEnvironment): string {
  return environment === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
}

/** Read the APNs config from the worker env; `null` when any piece is missing. */
export function apnsConfigFromEnv(env: {
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_TOPIC?: string;
}): ApnsConfig | null {
  const teamId = env.APNS_TEAM_ID?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const privateKeyPem = env.APNS_PRIVATE_KEY?.trim();
  const topic = env.APNS_TOPIC?.trim();
  if (!teamId || !keyId || !privateKeyPem || !topic) return null;
  return { teamId, keyId, privateKeyPem, topic };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Build the `aps` payload for a category. Metadata only — see module doc. */
export function buildApnsPayload(request: ApnsPushRequest): ApnsPayload {
  const sudo = request.category === 'sudo_request';
  const alert = sudo
    ? { title: 'Approval needed', body: `${request.label} is waiting for your approval` }
    : { title: request.label, body: 'Finished — your turn' };
  return {
    aps: {
      alert,
      sound: 'default',
      category: APNS_CATEGORY_IDS[request.category],
      'thread-id': request.trayId,
      'interruption-level': sudo ? 'time-sensitive' : 'active',
      ...(sudo ? { 'relevance-score': 1 } : {}),
    },
    slicc: {
      category: request.category,
      trayId: request.trayId,
      ...(request.requestId ? { requestId: request.requestId } : {}),
    },
  };
}

/**
 * Production sender: signs JWTs with WebCrypto and POSTs to APNs over `fetch`.
 */
export class WebCryptoApnsSender implements ApnsSender {
  private jwt: { value: string; mintedAt: number } | null = null;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(
    private readonly config: ApnsConfig,
    private readonly deps: { fetchImpl?: typeof fetch; now?: () => number } = {}
  ) {}

  private importKey(): Promise<CryptoKey> {
    this.keyPromise ??= crypto.subtle.importKey(
      'pkcs8',
      pemToPkcs8(this.config.privateKeyPem),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    return this.keyPromise;
  }

  /** Current provider JWT, minting a fresh one when missing or older than 50 min. */
  async providerToken(forceRefresh = false): Promise<string> {
    const now = this.deps.now?.() ?? Date.now();
    if (!forceRefresh && this.jwt && now - this.jwt.mintedAt < JWT_TTL_MS) return this.jwt.value;
    const enc = new TextEncoder();
    const header = base64UrlEncode(
      enc.encode(JSON.stringify({ alg: 'ES256', kid: this.config.keyId }))
    );
    const claims = base64UrlEncode(
      enc.encode(JSON.stringify({ iss: this.config.teamId, iat: Math.floor(now / 1000) }))
    );
    const signingInput = `${header}.${claims}`;
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      await this.importKey(),
      enc.encode(signingInput)
    );
    const value = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
    this.jwt = { value, mintedAt: now };
    return value;
  }

  async send(request: ApnsPushRequest): Promise<ApnsPushResult> {
    const first = await this.post(request, await this.providerToken());
    if (first.reason && STALE_JWT_REASONS.has(first.reason)) {
      return this.post(request, await this.providerToken(true));
    }
    return first;
  }

  private async post(request: ApnsPushRequest, jwt: string): Promise<ApnsPushResult> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const sudo = request.category === 'sudo_request';
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      'apns-topic': this.config.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    };
    if (sudo) {
      const now = this.deps.now?.() ?? Date.now();
      headers['apns-expiration'] = String(Math.floor(now / 1000) + SUDO_EXPIRY_SECONDS);
      if (request.requestId) headers['apns-collapse-id'] = request.requestId.slice(0, 64);
    } else {
      headers['apns-collapse-id'] = `turn-end:${request.trayId}`.slice(0, 64);
    }
    try {
      const response = await fetchImpl(
        `${apnsHost(request.environment)}/3/device/${request.token}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(buildApnsPayload(request)),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );
      let reason: string | undefined;
      if (!response.ok) {
        try {
          reason = ((await response.json()) as { reason?: string }).reason;
        } catch {
          reason = undefined;
        }
      }
      return {
        token: request.token,
        status: response.status,
        ...(reason ? { reason } : {}),
        dropToken:
          response.status === 410 || (reason !== undefined && DEAD_TOKEN_REASONS.has(reason)),
      };
    } catch (err) {
      return {
        token: request.token,
        status: 0,
        reason: err instanceof Error ? err.message : String(err),
        dropToken: false,
      };
    }
  }
}
