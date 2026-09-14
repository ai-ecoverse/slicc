export interface ApnsConfig {
  teamId: string;
  keyId: string;

  privateKeyPem: string;

  topic: string;
}

export type ApnsEnvironment = 'sandbox' | 'production';

export type PushCategory = 'turn_end' | 'sudo_request';

export interface ApnsPushRequest {
  token: string;
  environment: ApnsEnvironment;
  category: PushCategory;

  label: string;
  trayId: string;
  requestId?: string;
}

export interface ApnsPushResult {
  token: string;

  status: number;

  reason?: string;

  dropToken: boolean;

  uniqueId?: string;

  invalidatedAtMs?: number;
}

export interface ApnsProviderToken {
  value: string;
  mintedAt: number;

  identity: string;
}

export interface ApnsProviderTokenSource {
  getToken(staleToken?: string): Promise<ApnsProviderToken>;
}

export interface ProviderTokenStore {
  load(): Promise<ApnsProviderToken | null>;
  save(token: ApnsProviderToken): Promise<void>;
}

export interface ApnsSender {
  send(request: ApnsPushRequest): Promise<ApnsPushResult>;
}

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

export const APNS_CATEGORY_IDS: Record<PushCategory, string> = {
  turn_end: 'SLICC_TURN_END',
  sudo_request: 'SLICC_SUDO_REQUEST',
};

const JWT_TTL_MS = 50 * 60 * 1000;

export const JWT_MIN_MINT_INTERVAL_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;

export const APNS_TIMEOUT_REASON = 'APNs request timed out';

const TRANSIENT_RETRY_DELAY_MS = 250;

const SUDO_EXPIRY_SECONDS = 5 * 60;

const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

const STALE_JWT_REASONS = new Set([
  'ExpiredProviderToken',
  'InvalidProviderToken',
  'TooManyProviderTokenUpdates',
]);

const TRANSIENT_STATUSES = new Set([500, 503]);

export function apnsHost(environment: ApnsEnvironment): string {
  return environment === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
}

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

export class LocalProviderTokenMinter implements ApnsProviderTokenSource {
  private cached: ApnsProviderToken | null = null;
  private keyPromise: Promise<CryptoKey> | null = null;
  private mintInFlight: Promise<ApnsProviderToken> | null = null;
  private readonly now: () => number;
  private readonly store: ProviderTokenStore | undefined;
  private readonly identity: string;

  constructor(
    private readonly config: ApnsConfig,
    deps: { now?: () => number; store?: ProviderTokenStore } = {}
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.store = deps.store;
    this.identity = providerTokenIdentity(config);
  }

  async getToken(staleToken?: string): Promise<ApnsProviderToken> {
    const cached = await this.loadCached();
    const now = this.now();
    if (cached) {
      if (staleToken !== undefined && cached.value !== staleToken) return cached;
      if (staleToken === undefined && now - cached.mintedAt < JWT_TTL_MS) return cached;

      if (now - cached.mintedAt < JWT_MIN_MINT_INTERVAL_MS) return cached;
    }
    return this.mintShared(now);
  }

  private async loadCached(): Promise<ApnsProviderToken | null> {
    if (this.cached) return this.cached;
    const stored = (await this.store?.load()) ?? null;

    this.cached = stored && stored.identity === this.identity ? stored : null;
    return this.cached;
  }

  private mintShared(now: number): Promise<ApnsProviderToken> {
    this.mintInFlight ??= this.mint(now)
      .then(async (token) => {
        this.cached = token;
        await this.store?.save(token);
        return token;
      })
      .finally(() => {
        this.mintInFlight = null;
      });
    return this.mintInFlight;
  }

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

  private async mint(now: number): Promise<ApnsProviderToken> {
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
    return {
      value: `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`,
      mintedAt: now,
      identity: this.identity,
    };
  }
}

export function providerTokenIdentity(config: Pick<ApnsConfig, 'teamId' | 'keyId'>): string {
  return `${config.teamId}.${config.keyId}`;
}

function isRetryable(result: ApnsPushResult): boolean {
  if (TRANSIENT_STATUSES.has(result.status)) return true;
  return result.status === 0 && result.reason !== APNS_TIMEOUT_REASON;
}

export class WebCryptoApnsSender implements ApnsSender {
  private readonly tokenSource: ApnsProviderTokenSource;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: ApnsConfig,
    private readonly deps: {
      fetchImpl?: typeof fetch;
      now?: () => number;
      tokenSource?: ApnsProviderTokenSource;
      sleep?: (ms: number) => Promise<void>;
    } = {}
  ) {
    this.tokenSource = deps.tokenSource ?? new LocalProviderTokenMinter(config, { now: deps.now });
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async send(request: ApnsPushRequest): Promise<ApnsPushResult> {
    const token = await this.tokenSource.getToken();
    const first = await this.post(request, token.value);

    if (first.reason && STALE_JWT_REASONS.has(first.reason)) {
      const refreshed = await this.tokenSource.getToken(token.value);

      if (refreshed.value === token.value) return first;
      return this.post(request, refreshed.value);
    }

    if (isRetryable(first)) {
      await this.sleep(TRANSIENT_RETRY_DELAY_MS);
      return this.post(request, token.value);
    }
    return first;
  }

  private buildHeaders(request: ApnsPushRequest, jwt: string): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      'apns-topic': this.config.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    };
    if (request.category === 'sudo_request') {
      const now = this.deps.now?.() ?? Date.now();
      headers['apns-expiration'] = String(Math.floor(now / 1000) + SUDO_EXPIRY_SECONDS);
      if (request.requestId) headers['apns-collapse-id'] = request.requestId.slice(0, 64);
    } else {
      headers['apns-collapse-id'] = `turn-end:${request.trayId}`.slice(0, 64);
    }
    return headers;
  }

  private async post(request: ApnsPushRequest, jwt: string): Promise<ApnsPushResult> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `${apnsHost(request.environment)}/3/device/${request.token}`,
        {
          method: 'POST',
          headers: this.buildHeaders(request, jwt),
          body: JSON.stringify(buildApnsPayload(request)),
          signal: controller.signal,
        }
      );
      const uniqueId = response.headers.get('apns-unique-id') ?? undefined;
      let reason: string | undefined;
      let invalidatedAtMs: number | undefined;
      if (!response.ok) {
        try {
          const body = (await response.json()) as { reason?: string; timestamp?: number };
          reason = body.reason;
          if (typeof body.timestamp === 'number' && Number.isFinite(body.timestamp)) {
            invalidatedAtMs = body.timestamp;
          }
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
        ...(uniqueId ? { uniqueId } : {}),
        ...(invalidatedAtMs !== undefined ? { invalidatedAtMs } : {}),
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return {
        token: request.token,
        status: 0,
        reason: aborted ? APNS_TIMEOUT_REASON : err instanceof Error ? err.message : String(err),
        dropToken: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
