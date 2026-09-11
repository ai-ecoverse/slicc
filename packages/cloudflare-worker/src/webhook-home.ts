/**
 * WebhookHome — the stable, cone-scoped indirection in front of a tray's
 * webhook surface (issue #2812).
 *
 * ## Why this exists
 *
 * A tray-scoped webhook URL (`/webhook/<trayId>.<secret>/<id>`) names an
 * INSTANCE. An external service caches that URL for the life of a job — up to
 * hours — and if the tray roves in the meantime (reset, reconnect, expiry) the
 * cached URL points at a dead object. #1957 patched that with a 308 redirect,
 * but a redirect only works for a sender that follows POST redirects, and it
 * hands the replacement's webhook capability out in a `Location` header.
 *
 * A `WebhookHome` removes the failure mode instead of catching it. It is keyed
 * by a `coneId` that is minted ONCE and never rotates, so the delivery URL
 * (`/webhook/<coneId>.<secret>/<id>`) is stable for the life of the cone. One
 * indirection resolves the home to whichever tray is current, and delivery is
 * an INTERNAL FORWARD — no redirect, no capability in a response header, and no
 * dependence on the sender following anything.
 *
 * ## Storage (DO storage, never KV)
 *
 * `{ coneId, secretHash, currentTrayId, revokedAt?, createdAt, lastReboundAt }`.
 * The moment the mapping matters is the instant after a rebind, which is
 * exactly when KV would still be serving the old tray — so it lives in the
 * strongly-consistent DO storage, keyed by `idFromName(coneId)`.
 *
 * Only the secret HASH is stored: a home that leaked its storage must not leak
 * a working webhook capability.
 *
 * ## Rebind authorization (the strong option from #2812)
 *
 * Whoever can rebind a home redirects every future delivery for that cone, so
 * the gate is deliberately two-factor:
 *
 *   1. the home's own `rebindSecret` (proves possession of the cone identity), AND
 *   2. the TARGET tray confirming the presented controller token (proves the
 *      caller actually leads the tray it is pointing the home at).
 *
 * The confirmation is a round trip to the target tray's `/internal/confirm-
 * controller` on every rebind. It means a leaked `coneId` + `rebindSecret`
 * alone cannot steer deliveries at a tray the attacker does not lead. The
 * FIRST bind (cone creation) has no prior secret, so it is claimed by the
 * first caller who proves controller ownership of the initial tray, and that
 * caller receives the `rebindSecret` for every later rebind.
 */

import { jsonResponse } from './shared.js';
import { timingSafeEqual } from './timing-safe-equal.js';

/** How long a home stays resolvable with no rebind before it self-expires. */
export const WEBHOOK_HOME_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Persisted home record. Never contains the raw secret — only its SHA-256. */
export interface WebhookHomeRecord {
  coneId: string;
  /** SHA-256 hex of the delivery secret (the `<secret>` half of the token). */
  secretHash: string;
  /** SHA-256 hex of the rebind secret handed to the cone owner on first bind. */
  rebindSecretHash: string;
  /** The tray a delivery is currently forwarded to. */
  currentTrayId: string;
  createdAt: string;
  lastReboundAt: string;
  /** ISO tombstone. Once set the home answers a permanent 410 and never resolves. */
  revokedAt?: string;
}

export interface WebhookHomeStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface WebhookHomeStateLike {
  storage: WebhookHomeStorageLike;
}

/** A stub the home can `fetch()` to reach a tray DO (for controller confirm + forward). */
export interface WebhookHomeTrayStub {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface WebhookHomeEnv {
  TRAY_HUB: {
    idFromName(name: string): { toString(): string };
    get(id: { toString(): string }): WebhookHomeTrayStub;
  };
}

const HOME_STORAGE_KEY = 'webhook-home';

/** SHA-256 hex of a UTF-8 string. */
async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The Durable Object. One instance per `coneId` (`idFromName(coneId)`).
 *
 * Routes (all `/internal/*`, reached only through the stub from `index.ts` —
 * never from the public edge):
 *   - `POST /internal/home/bind`    create or rebind the mapping
 *   - `POST /internal/home/deliver` verify the delivery secret and forward
 *   - `POST /internal/home/revoke`  tombstone the home
 */
export class WebhookHomeDurableObject {
  private home: WebhookHomeRecord | null = null;

  constructor(
    private readonly state: WebhookHomeStateLike,
    private readonly env: WebhookHomeEnv,
    private readonly options: { now?: () => number } = {}
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private async load(): Promise<void> {
    if (this.home) return;
    this.home = (await this.state.storage.get<WebhookHomeRecord>(HOME_STORAGE_KEY)) ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await this.load();
    if (url.pathname === '/internal/home/bind' && request.method === 'POST') {
      return this.handleBind(request);
    }
    if (url.pathname === '/internal/home/deliver' && request.method === 'POST') {
      return this.handleDeliver(request);
    }
    if (url.pathname === '/internal/home/revoke' && request.method === 'POST') {
      return this.handleRevoke(request);
    }
    return jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  /**
   * Create the home (first bind) or repoint it at a new tray (rebind).
   *
   * First bind: `{ coneId, secret, rebindSecret, trayId, controllerToken }`.
   * The caller must prove controller ownership of `trayId`; on success the home
   * is created and the caller keeps `rebindSecret` for later rebinds.
   *
   * Rebind: same body. The presented `rebindSecret` must match the stored hash
   * AND the NEW target tray must confirm `controllerToken` — both, so neither a
   * leaked coneId nor a leaked rebind secret alone can steer deliveries.
   */
  private async handleBind(request: Request): Promise<Response> {
    let body: {
      coneId?: string;
      secret?: string;
      rebindSecret?: string;
      trayId?: string;
      controllerToken?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid body', code: 'INVALID_BODY' }, 400);
    }
    const { coneId, secret, rebindSecret, trayId, controllerToken } = body;
    if (!coneId || !secret || !rebindSecret || !trayId || !controllerToken) {
      return jsonResponse({ error: 'Missing required field', code: 'INVALID_BODY' }, 400);
    }

    if (this.home?.revokedAt) {
      // A revoked home never resurrects — a tombstoned coneId is dead for good.
      return jsonResponse({ error: 'Webhook home revoked', code: 'HOME_REVOKED' }, 410);
    }

    // Rebind must present the matching rebind secret. First bind has none stored.
    if (this.home) {
      const presentedHash = await sha256Hex(rebindSecret);
      if (!timingSafeEqual(presentedHash, this.home.rebindSecretHash)) {
        return jsonResponse({ error: 'Invalid rebind capability', code: 'INVALID_REBIND' }, 403);
      }
    }

    // Both binds require the TARGET tray to confirm the controller token: the
    // caller must actually lead the tray it is pointing the home at. This is
    // the second factor — a leaked coneId + rebind secret cannot redirect
    // deliveries to a tray the attacker does not control.
    const confirmed = await this.confirmControllerOfTray(trayId, controllerToken);
    if (!confirmed) {
      return jsonResponse(
        { error: 'Target tray did not confirm controller', code: 'CONTROLLER_UNCONFIRMED' },
        403
      );
    }

    if (this.home) {
      this.home.currentTrayId = trayId;
      this.home.lastReboundAt = this.isoNow();
    } else {
      this.home = {
        coneId,
        secretHash: await sha256Hex(secret),
        rebindSecretHash: await sha256Hex(rebindSecret),
        currentTrayId: trayId,
        createdAt: this.isoNow(),
        lastReboundAt: this.isoNow(),
      };
    }
    await this.state.storage.put(HOME_STORAGE_KEY, this.home);
    return jsonResponse({ coneId: this.home.coneId, currentTrayId: this.home.currentTrayId }, 200);
  }

  /**
   * Verify the delivery secret and forward the delivery to the current tray's
   * internal webhook entrypoint. The tray runs the same relay it runs for a
   * public delivery, minus the public token check (the home already
   * authenticated the coneId secret). Returns the tray's response verbatim.
   */
  private async handleDeliver(request: Request): Promise<Response> {
    const cors = { 'access-control-allow-origin': '*' };
    // Secret + webhookId ride in reserved headers, out of band from the
    // sender's body — so the body reaches the tray relay verbatim and the
    // secret never has to be spliced into a payload the DO does not own.
    const secret = request.headers.get('x-slicc-cone-secret') ?? '';
    const webhookId = request.headers.get('x-slicc-webhook-id') ?? '';
    if (!secret || !webhookId) {
      return jsonResponse({ error: 'Missing required field', code: 'INVALID_BODY' }, 400, cors);
    }

    if (!this.home) {
      return jsonResponse(
        { error: 'Invalid webhook capability', code: 'INVALID_WEBHOOK_CAPABILITY' },
        403,
        cors
      );
    }
    if (this.home.revokedAt) {
      return jsonResponse({ error: 'Webhook home revoked', code: 'HOME_REVOKED' }, 410, cors);
    }
    if (this.isExpired()) {
      return jsonResponse({ error: 'Webhook home expired', code: 'HOME_EXPIRED' }, 410, cors);
    }
    const presentedHash = await sha256Hex(secret);
    if (!timingSafeEqual(presentedHash, this.home.secretHash)) {
      return jsonResponse(
        { error: 'Invalid webhook capability', code: 'INVALID_WEBHOOK_CAPABILITY' },
        403,
        cors
      );
    }

    // Internal forward to the current tray. No redirect, no capability leaves
    // the worker — the tray answers as if the delivery arrived on its own
    // webhook token, and we relay that answer straight back to the sender.
    // Buffer the body rather than stream it: webhook payloads are small, and a
    // streamed body would need `duplex: 'half'` (workerd-only) on the forward.
    const forwardBody = await request.arrayBuffer();
    const stub = this.env.TRAY_HUB.get(this.env.TRAY_HUB.idFromName(this.home.currentTrayId));
    const forwardUrl = new URL(request.url);
    forwardUrl.pathname = `/internal/webhook/${encodeURIComponent(webhookId)}`;
    forwardUrl.search = '';
    const forwarded = await stub.fetch(
      new Request(forwardUrl, {
        method: 'POST',
        headers: forwardableDeliveryHeaders(request),
        body: forwardBody,
      })
    );
    // Preserve the tray's status + body; ensure the CORS header the public
    // surface promises is present.
    const headers = new Headers(forwarded.headers);
    headers.set('access-control-allow-origin', '*');
    return new Response(forwarded.body, { status: forwarded.status, headers });
  }

  private async handleRevoke(request: Request): Promise<Response> {
    let body: { rebindSecret?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid body', code: 'INVALID_BODY' }, 400);
    }
    if (!this.home) {
      return jsonResponse({ error: 'No such home', code: 'NOT_FOUND' }, 404);
    }
    if (!body.rebindSecret) {
      return jsonResponse({ error: 'Missing rebind capability', code: 'INVALID_BODY' }, 400);
    }
    const presentedHash = await sha256Hex(body.rebindSecret);
    if (!timingSafeEqual(presentedHash, this.home.rebindSecretHash)) {
      return jsonResponse({ error: 'Invalid rebind capability', code: 'INVALID_REBIND' }, 403);
    }
    this.home.revokedAt = this.isoNow();
    await this.state.storage.put(HOME_STORAGE_KEY, this.home);
    return jsonResponse({ coneId: this.home.coneId, revoked: true }, 200);
  }

  private isExpired(): boolean {
    if (!this.home) return true;
    return Date.parse(this.home.lastReboundAt) + WEBHOOK_HOME_TTL_MS <= this.now();
  }

  /**
   * Ask the target tray to confirm the presented controller token. Reaches the
   * tray's `/internal/confirm-controller` route through the stub; a non-200 (or
   * any error) is a refusal, never an accept, so a tray outage fails the rebind
   * closed rather than open.
   */
  private async confirmControllerOfTray(trayId: string, controllerToken: string): Promise<boolean> {
    try {
      const stub = this.env.TRAY_HUB.get(this.env.TRAY_HUB.idFromName(trayId));
      const res = await stub.fetch(
        new Request('https://internal/internal/confirm-controller', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ controllerToken }),
        })
      );
      if (res.status !== 200) return false;
      const parsed = (await res.json()) as { confirmed?: boolean };
      return parsed.confirmed === true;
    } catch {
      return false;
    }
  }
}

/**
 * Headers to carry from the public delivery into the internal forward. Drops
 * Cloudflare-internal and hop-by-hop headers; the tray relay applies its own
 * `forwardableHeaders` filter on top (stripping the reserved preview headers),
 * so this is a coarse first pass that keeps `content-type` and the sender's
 * own headers intact.
 */
function forwardableDeliveryHeaders(request: Request): Headers {
  const out = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (key.startsWith('cf-') || key === 'host' || key === 'content-length') continue;
    // Reserved routing headers stop here — the delivery secret and id are for
    // the home, never the leader or the cone.
    if (key === 'x-slicc-cone-secret' || key === 'x-slicc-webhook-id') continue;
    out.set(key, value);
  }
  out.set('content-type', request.headers.get('content-type') ?? 'application/json');
  return out;
}
