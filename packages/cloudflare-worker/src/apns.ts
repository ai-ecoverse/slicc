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
 * Auth is token-based (a `.p8` key): an ES256 JWT signed with WebCrypto.
 * Apple throttles provider-token *creation* per (team id, key id) pair — not
 * per connection — and answers `429 TooManyProviderTokenUpdates` to a provider
 * that recreates tokens more than once every 20 minutes, so minting is
 * deliberately split out behind {@link ApnsProviderTokenSource}. One tray DO
 * per tray, each minting its own JWT, would blow that budget at a handful of
 * concurrent trays; `apns-provider-token.ts` funnels every DO through a single
 * minting instance. Missing secrets disable pushing entirely — the DO logs once
 * and treats every send as a no-op, so the rest of the tray never depends on
 * APNs.
 *
 * APNs requires HTTP/2. Deployed Workers negotiate it with Apple's gateway;
 * `wrangler dev` on macOS does not (workerd#4841), so local runs of this path
 * fail in a way staging does not.
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
  /**
   * `apns-unique-id` response header. Apple asks for this when investigating a
   * push that never arrived, and it is the only handle on a specific delivery.
   */
  uniqueId?: string;
  /**
   * `timestamp` from a 410 body: when the device token stopped being valid.
   * A registration newer than this instant is still live, so the caller keeps
   * it (see `handlePushSend`). Absent on 400 BadDeviceToken, which is final.
   */
  invalidatedAtMs?: number;
}

/** A minted provider JWT and the instant it was signed. */
export interface ApnsProviderToken {
  value: string;
  mintedAt: number;
  /**
   * `teamId.keyId` of the credentials that signed it. Apple's 20-minute floor
   * is per key pair, so a token from *different* credentials is not merely
   * stale — it must be discarded and re-minted at once, or a key rotation
   * would disable pushes for the length of the floor (a revoked key answers
   * `InvalidProviderToken`, which the floor otherwise refuses to act on).
   */
  identity: string;
}

/**
 * Supplies the provider JWT. Implementations are shared across tray DOs, so
 * `getToken` is expected to hand back a *cached* token almost every time.
 */
export interface ApnsProviderTokenSource {
  /**
   * The current provider JWT. Pass `staleToken` — the exact value APNs just
   * rejected — to ask for a replacement; the source rotates only when its own
   * cached token still matches, so a herd of DOs reporting the same rejection
   * causes one mint, not one per caller.
   */
  getToken(staleToken?: string): Promise<ApnsProviderToken>;
}

/** Durable place to keep the minted JWT so DO hibernation does not re-mint. */
export interface ProviderTokenStore {
  load(): Promise<ApnsProviderToken | null>;
  save(token: ApnsProviderToken): Promise<void>;
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

/** Rotate at 50 min: inside Apple's 60-minute expiry, outside its 20-minute floor. */
const JWT_TTL_MS = 50 * 60 * 1000;
/**
 * Apple's floor on provider-token creation. Minting more often than this earns
 * `429 TooManyProviderTokenUpdates`, which outlasts the push that triggered it,
 * so this is enforced even when a caller reports its token rejected.
 */
export const JWT_MIN_MINT_INTERVAL_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
/** Reason reported when the gateway never answered inside the budget. */
export const APNS_TIMEOUT_REASON = 'APNs request timed out';
/** One short retry for a blip; long enough to clear, short enough to not stall the DO. */
const TRANSIENT_RETRY_DELAY_MS = 250;
/** Sudo banners are pointless after the leader's 5-minute deadline. */
const SUDO_EXPIRY_SECONDS = 5 * 60;

/** Reasons that mean "this token will never work again". */
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
/**
 * Reasons that mean "the JWT we presented is not usable; ask the source for the
 * current one". `TooManyProviderTokenUpdates` belongs here even though nothing
 * is wrong with our token: it means another minter rotated recently, so the
 * shared source very likely holds a newer token we should be using instead.
 * Crucially it must never *cause* a mint — the source's floor guarantees that.
 */
const STALE_JWT_REASONS = new Set([
  'ExpiredProviderToken',
  'InvalidProviderToken',
  'TooManyProviderTokenUpdates',
]);
/** Server-side blips worth exactly one more attempt. */
const TRANSIENT_STATUSES = new Set([500, 503]);

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
 * Signs provider JWTs with WebCrypto and caches the result, optionally through
 * a {@link ProviderTokenStore} so a hibernated Durable Object resumes with the
 * same token instead of minting a fresh one on every wake.
 *
 * One of these should be live per worker, not per tray — see the module doc.
 */
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
      // Someone already rotated past the token this caller had rejected.
      if (staleToken !== undefined && cached.value !== staleToken) return cached;
      if (staleToken === undefined && now - cached.mintedAt < JWT_TTL_MS) return cached;
      // Rotating now would trip Apple's 20-minute floor, and the 429 that earns
      // costs more than the one push we are trying to rescue. Re-minting a
      // token seconds old would also reproduce the same `iat`, so a caller
      // reporting a just-minted token stale gains nothing from a fresh one.
      if (now - cached.mintedAt < JWT_MIN_MINT_INTERVAL_MS) return cached;
    }
    return this.mintShared(now);
  }

  private async loadCached(): Promise<ApnsProviderToken | null> {
    if (this.cached) return this.cached;
    const stored = (await this.store?.load()) ?? null;
    // Signed by credentials we no longer hold (rotated key id / team id, or a
    // record predating this field): unusable, and holding it would stall the
    // first mint under the floor. Drop it and sign fresh — the new key pair
    // has its own budget with Apple.
    this.cached = stored && stored.identity === this.identity ? stored : null;
    return this.cached;
  }

  /** Collapse concurrent callers onto one signature + one store write. */
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

/** Which credentials signed a token — see {@link ApnsProviderToken.identity}. */
export function providerTokenIdentity(config: Pick<ApnsConfig, 'teamId' | 'keyId'>): string {
  return `${config.teamId}.${config.keyId}`;
}

/** Blips worth one retry. A timeout is excluded: it already cost the full budget. */
function isRetryable(result: ApnsPushResult): boolean {
  if (TRANSIENT_STATUSES.has(result.status)) return true;
  return result.status === 0 && result.reason !== APNS_TIMEOUT_REASON;
}

/**
 * Production sender: POSTs to APNs over `fetch`, taking its provider JWT from
 * an {@link ApnsProviderTokenSource} rather than minting per instance.
 */
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
      // Re-posting the very token Apple just rejected only burns a second
      // request; the source declining to rotate is its answer, not a hint to
      // try again. Retry only against a genuinely different token.
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
    // An AbortController whose timer is cleared, rather than
    // `AbortSignal.timeout`: that one stays armed after the response lands and
    // keeps the Durable Object's IO context alive for the full budget, billing
    // ~8s of wall time for every push that actually succeeded (issue #2432).
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
