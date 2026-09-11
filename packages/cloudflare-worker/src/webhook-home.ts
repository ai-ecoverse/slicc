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
import { readBoundedWebhookBody, WebhookBodyError, withWebhookTimeout } from './webhook-body.js';

/** How long a home stays resolvable with no rebind before it self-expires. */
export const WEBHOOK_HOME_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Bounded queue that holds deliveries arriving while no leader is connected,
 * replayed to the current tray on the next successful forward or a rebind
 * (#2812). Semantics, chosen deliberately per the issue's open question:
 *
 *   - **At-least-once.** Until acknowledged or explicitly rejected, a queued
 *     delivery is retained. A crash mid-drain replays it — a webhook consumer must
 *     already tolerate a retry, so at-least-once beats the silent loss it
 *     replaces.
 *   - **Ordered per ID.** Explicit rejection backoff can be bypassed by another
 *     ID, never by a later delivery of the same ID.
 *   - **Bounded.** Count and encoded-storage byte limits reject NEW requests
 *     with backpressure. Accepted events are never evicted or aged out.
 *   - **Durable retry.** An alarm retries even if bind precedes leader connect.
 *     Repeated explicit registration failures terminate in a bounded dead-letter
 *     archive; transient or ambiguous failures never exhaust a retry budget.
 */
export const WEBHOOK_QUEUE_MAX = 100;
/** Legacy horizon, retained for migration tests only; accepted events no longer expire. */
export const WEBHOOK_QUEUE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
/** Below the DO's 128 KiB per-value ceiling, including base64 and JSON overhead. */
export const WEBHOOK_QUEUE_MAX_BYTES = 120 * 1024;
export const WEBHOOK_QUEUE_RETRY_MS = 30_000;
export const WEBHOOK_QUEUE_REJECTION_MAX = 3;
/** Terminal outcomes only: oldest archived details are replaced, never pending events. */
export const WEBHOOK_DEAD_LETTER_MAX = 100;
/** Reserve per-entry retry metadata and room for the outcome counter. */
const QUEUE_RETRY_METADATA_BYTES = 256;

type RegistrationFailure = 'WEBHOOK_NOT_REGISTERED' | 'WEBHOOK_TARGET_UNRESOLVED';

export interface WebhookDeadLetter {
  sequence: number;
  outcome: 'rejected';
  reason: RegistrationFailure;
  attempts: number;
  failedAt: string;
  delivery: QueuedDelivery;
}

/** One delivery held for replay. The body is stored base64 so it round-trips any payload. */
export interface QueuedDelivery {
  webhookId: string;
  /** Base64 of the raw request body. */
  bodyB64: string;
  /** The sender's forwardable headers (the tray relay filters them again on delivery). */
  headers: Record<string, string>;
  enqueuedAt: string;
  rejection?: { attempts: number; retryAt: number };
}

/** Persisted home record. Never contains the raw secret — only its SHA-256. */
export interface WebhookHomeRecord {
  coneId: string;
  /** SHA-256 hex of the delivery secret (the `<secret>` half of the token). */
  secretHash: string;
  /** SHA-256 hex of the rebind secret handed to the cone owner on first bind. */
  rebindSecretHash: string;
  /** Hash of the last committed rotation request; permits exact no-mutation retries. */
  rotationReceiptHash?: string;
  /** The tray a delivery is currently forwarded to. */
  currentTrayId: string;
  createdAt: string;
  lastReboundAt: string;
  /** ISO tombstone. Once set the home answers a permanent 410 and never resolves. */
  revokedAt?: string;
  /** Deliveries awaiting a live leader, oldest first. Absent = empty. */
  queue?: QueuedDelivery[];
  /** Historical count written by the former drop-oldest queue; never incremented now. */
  droppedCount?: number;
  /** Lifetime terminal outcomes; details retain only the last WEBHOOK_DEAD_LETTER_MAX. */
  deadLetterCount?: number;
}

export interface WebhookHomeStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  /** DO multi-key puts are atomic: archive outcome and queue removal commit together. */
  put(entries: Record<string, WebhookHomeRecord | WebhookDeadLetter>): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
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

/** Base64-encode raw bytes (for queue persistence — round-trips any payload). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode base64 back to bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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
  private operation: Promise<unknown> = Promise.resolve();
  private pendingRequests = 0;

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

  /** Serialize across external awaits; DO input gates alone do not prevent races. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operation.then(run).catch((error: unknown) => {
      // Never let failed persistence leave a successful-looking in-memory mutation.
      this.home = null;
      throw error;
    });
    this.operation = next.catch(() => {});
    return next;
  }

  fetch(request: Request): Promise<Response> {
    // Bound waiters as well as durable storage; slow external I/O cannot turn
    // the serialization chain into an unbounded in-memory request queue.
    if (this.pendingRequests >= 8) {
      void request.body?.cancel().catch(() => {});
      return Promise.resolve(
        jsonResponse({ error: 'Webhook home busy; retry later', code: 'WEBHOOK_HOME_BUSY' }, 429, {
          'retry-after': '30',
          'access-control-allow-origin': '*',
        })
      );
    }
    this.pendingRequests++;
    return this.exclusive(() => this.dispatch(request)).finally(() => {
      this.pendingRequests--;
    });
  }

  alarm(): Promise<void> {
    return this.exclusive(async () => {
      await this.load();
      await this.drainQueue();
    });
  }

  private async dispatch(request: Request): Promise<Response> {
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
    if (url.pathname === '/internal/home/rotate' && request.method === 'POST') {
      return this.handleRotate(request);
    }
    if (url.pathname === '/internal/home/revoke-registration' && request.method === 'POST') {
      return this.handleRevokeRegistration(request);
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
      body = JSON.parse(
        new TextDecoder().decode(await readBoundedWebhookBody(request))
      ) as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid body', code: 'INVALID_BODY' }, 400);
    }
    const { coneId, secret, rebindSecret, trayId, controllerToken } = body ?? {};
    if (
      ![coneId, secret, rebindSecret, trayId, controllerToken].every(
        (v) => typeof v === 'string' && v.length > 0
      )
    ) {
      return jsonResponse({ error: 'Missing required field', code: 'INVALID_BODY' }, 400);
    }

    // Rebind must present the matching rebind secret. First bind has none stored.
    if (this.home) {
      const presentedHash = await sha256Hex(rebindSecret!);
      if (!timingSafeEqual(presentedHash, this.home.rebindSecretHash)) {
        return jsonResponse({ error: 'Invalid rebind capability', code: 'INVALID_REBIND' }, 403);
      }
    }
    if (this.home?.revokedAt) {
      return jsonResponse({ error: 'Webhook home revoked', code: 'HOME_REVOKED' }, 410);
    }
    if (this.home && !timingSafeEqual(await sha256Hex(secret!), this.home.secretHash)) {
      return jsonResponse(
        { error: 'Stale delivery capability', code: 'INVALID_WEBHOOK_CAPABILITY' },
        403
      );
    }

    // Both binds require the TARGET tray to confirm the controller token: the
    // caller must actually lead the tray it is pointing the home at. This is
    // the second factor — a leaked coneId + rebind secret cannot redirect
    // deliveries to a tray the attacker does not control.
    const confirmed = await this.confirmControllerOfTray(trayId!, controllerToken!);
    if (!confirmed) {
      return jsonResponse(
        { error: 'Target tray did not confirm controller', code: 'CONTROLLER_UNCONFIRMED' },
        403
      );
    }

    if (this.home) {
      this.home.currentTrayId = trayId!;
      this.home.lastReboundAt = this.isoNow();
    } else {
      this.home = {
        coneId: coneId!,
        secretHash: await sha256Hex(secret!),
        rebindSecretHash: await sha256Hex(rebindSecret!),
        currentTrayId: trayId!,
        createdAt: this.isoNow(),
        lastReboundAt: this.isoNow(),
      };
    }
    await this.state.storage.put(HOME_STORAGE_KEY, this.home);
    // Bind normally precedes leader connect. Try once here; the durable alarm
    // keeps retrying after connect even when no further webhook request arrives.
    await this.drainQueue();
    return jsonResponse(
      {
        coneId: this.home.coneId,
        currentTrayId: this.home.currentTrayId,
        queued: this.home.queue?.length ?? 0,
      },
      200
    );
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
    const presentedHash = await sha256Hex(secret);
    if (!timingSafeEqual(presentedHash, this.home.secretHash)) {
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
    if (await this.isRegistrationRevoked(webhookId)) {
      return jsonResponse(
        { error: 'Webhook registration revoked', code: 'WEBHOOK_REVOKED' },
        410,
        cors
      );
    }

    let forwardBody: Uint8Array;
    try {
      forwardBody = await readBoundedWebhookBody(request);
    } catch (error) {
      if (!(error instanceof WebhookBodyError)) throw error;
      return jsonResponse(
        { error: error.message, code: 'WEBHOOK_BODY_REJECTED' },
        error.status,
        cors
      );
    }
    const headers = forwardableDeliveryHeaders(request);
    const delivery: QueuedDelivery = {
      webhookId,
      bodyB64: bytesToBase64(forwardBody),
      headers,
      enqueuedAt: this.isoNow(),
    };
    if (!(await this.enqueue(delivery))) {
      return jsonResponse(
        { error: 'Webhook queue full; retry later', code: 'WEBHOOK_QUEUE_FULL' },
        429,
        { ...cors, 'retry-after': '30' }
      );
    }
    await this.drainQueue();
    return jsonResponse(
      { ok: true, accepted: true, queued: this.home.queue?.includes(delivery) ?? false },
      202,
      cors
    );
  }

  /** Forward one delivery to the current tray's internal webhook entrypoint. */
  private async forwardToTray(
    webhookId: string,
    body: ArrayBuffer | Uint8Array,
    headers: Record<string, string>
  ): Promise<Response> {
    const trayId = this.home!.currentTrayId;
    const stub = this.env.TRAY_HUB.get(this.env.TRAY_HUB.idFromName(trayId));
    const controller = new AbortController();
    return withWebhookTimeout(
      stub.fetch(
        new Request(`https://internal/internal/webhook/${encodeURIComponent(webhookId)}`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', ...headers },
          body,
        })
      ),
      () => controller.abort()
    );
  }

  /** Persist before sending or accepting; never evict an already accepted event. */
  private async enqueue(delivery: QueuedDelivery): Promise<boolean> {
    if (!this.home) return false;
    const queue = this.home.queue ?? [];
    const next = { ...this.home, queue: [...queue, delivery] };
    if (
      queue.length >= WEBHOOK_QUEUE_MAX ||
      new TextEncoder().encode(JSON.stringify(next)).byteLength +
        next.queue.length * QUEUE_RETRY_METADATA_BYTES >
        WEBHOOK_QUEUE_MAX_BYTES
    ) {
      return false;
    }
    // Schedule BEFORE persisting: a crash between the two cannot strand accepted work.
    await this.state.storage.setAlarm(this.now() + WEBHOOK_QUEUE_RETRY_MS);
    await this.state.storage.put(HOME_STORAGE_KEY, next);
    this.home = next;
    return true;
  }

  /**
   * Replay oldest eligible delivery, bypassing only explicit rejection backoff.
   * An ambiguous outcome remains blocking; same-ID arrival order is preserved.
   * Explicit registration rejections get three spaced attempts before dead-lettering.
   * One event per invocation bounds request lifetime; the alarm continues the FIFO.
   */
  private async drainQueue(): Promise<void> {
    if (!this.home?.queue?.length) return;
    if (this.home.revokedAt) return;
    await this.state.storage.setAlarm(this.now() + WEBHOOK_QUEUE_RETRY_MS);
    const next = this.nextEligibleDelivery();
    if (!next) return;
    if (await this.isRegistrationRevoked(next.webhookId)) {
      await this.removeQueuedDelivery(next);
      return;
    }
    const result = await this.attemptDelivery(next);
    if (result === 'acknowledged') {
      await this.removeQueuedDelivery(next);
    } else if (result) {
      await this.recordRejection(next, result);
      if (this.nextEligibleDelivery()) await this.state.storage.setAlarm(this.now() + 1_000);
    } else if (next.rejection) {
      // An ambiguous attempt breaks the rejection streak; it can never be the
      // attempt that spends the terminal budget.
      delete next.rejection;
      await this.state.storage.put(HOME_STORAGE_KEY, this.home);
    }
  }

  private nextEligibleDelivery(): QueuedDelivery | undefined {
    const blockedIds = new Set<string>();
    for (const entry of this.home?.queue ?? []) {
      if (blockedIds.has(entry.webhookId)) continue;
      if (!entry.rejection || entry.rejection.retryAt <= this.now()) return entry;
      blockedIds.add(entry.webhookId);
    }
    return undefined;
  }

  private async attemptDelivery(
    next: QueuedDelivery
  ): Promise<RegistrationFailure | 'acknowledged' | null> {
    try {
      const forwarded = await this.forwardToTray(
        next.webhookId,
        base64ToBytes(next.bodyB64),
        next.headers
      );
      const ack = forwarded.headers.get('x-slicc-webhook-ack');
      if (forwarded.status < 300 && (ack === 'delivered' || ack === 'filtered')) {
        void forwarded.body?.cancel().catch(() => {});
        return 'acknowledged';
      }
      if (forwarded.status !== 404 && forwarded.status !== 422) {
        void forwarded.body?.cancel().catch(() => {});
        return null;
      }
      const body = JSON.parse(
        new TextDecoder().decode(await readBoundedWebhookBody(forwarded))
      ) as { accepted?: boolean; code?: string } | null;
      if (body?.accepted !== false) return null;
      if (forwarded.status === 404 && body.code === 'WEBHOOK_NOT_REGISTERED') {
        return 'WEBHOOK_NOT_REGISTERED';
      }
      if (forwarded.status === 422 && body.code === 'WEBHOOK_TARGET_UNRESOLVED') {
        return 'WEBHOOK_TARGET_UNRESOLVED';
      }
    } catch {
      // Transport, body-read and parse failures are ambiguous; retain for replay.
    }
    return null;
  }

  private async recordRejection(
    delivery: QueuedDelivery,
    reason: RegistrationFailure
  ): Promise<void> {
    const attempts = (delivery.rejection?.attempts ?? 0) + 1;
    if (attempts < WEBHOOK_QUEUE_REJECTION_MAX) {
      delivery.rejection = { attempts, retryAt: this.now() + WEBHOOK_QUEUE_RETRY_MS };
      await this.state.storage.put(HOME_STORAGE_KEY, this.home!);
      return;
    }
    const sequence = (this.home!.deadLetterCount ?? 0) + 1;
    const archive: WebhookDeadLetter = {
      sequence,
      outcome: 'rejected',
      reason,
      attempts,
      failedAt: this.isoNow(),
      delivery,
    };
    const home: WebhookHomeRecord = {
      ...this.home!,
      deadLetterCount: sequence,
      queue: this.home!.queue!.filter((entry) => entry !== delivery),
    };
    if (!home.queue!.length) delete home.queue;
    // A single atomic multi-key put prevents both loss and a contradictory
    // terminal receipt followed by replay after a crash.
    await this.state.storage.put({
      [HOME_STORAGE_KEY]: home,
      [`webhook-dead-letter:${(sequence - 1) % WEBHOOK_DEAD_LETTER_MAX}`]: archive,
    });
    this.home = home;
    if (home.queue?.length) await this.state.storage.setAlarm(this.now() + 1_000);
  }

  private async removeQueuedDelivery(delivery: QueuedDelivery): Promise<void> {
    if (!this.home?.queue) return;
    this.home.queue = this.home.queue.filter((entry) => entry !== delivery);
    if (this.home.queue.length === 0) delete this.home.queue;
    await this.state.storage.put(HOME_STORAGE_KEY, this.home);
    if (this.home.queue?.length) await this.state.storage.setAlarm(this.now() + 1_000);
  }

  private async isRegistrationRevoked(webhookId: string): Promise<boolean> {
    return (
      (await this.state.storage.get(`revoked-registration:${await sha256Hex(webhookId)}`)) !==
      undefined
    );
  }

  /** Tombstones use separate keys and are never evicted to make room for events. */
  private async handleRevokeRegistration(request: Request): Promise<Response> {
    let body: {
      webhookId?: string;
      rebindSecret?: string;
      trayId?: string;
      controllerToken?: string;
    };
    try {
      body = JSON.parse(
        new TextDecoder().decode(await readBoundedWebhookBody(request))
      ) as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid body', code: 'INVALID_BODY' }, 400);
    }
    const { webhookId, rebindSecret, trayId, controllerToken } = body ?? {};
    if (
      ![webhookId, rebindSecret, trayId, controllerToken].every(
        (v) => typeof v === 'string' && v.length > 0
      ) ||
      webhookId!.length > 1024
    ) {
      return jsonResponse({ error: 'Invalid body', code: 'INVALID_BODY' }, 400);
    }
    if (
      !this.home ||
      !timingSafeEqual(await sha256Hex(rebindSecret!), this.home.rebindSecretHash)
    ) {
      return jsonResponse({ error: 'Invalid rebind capability', code: 'INVALID_REBIND' }, 403);
    }
    if (
      this.home.currentTrayId !== trayId ||
      !(await this.confirmControllerOfTray(trayId!, controllerToken!))
    ) {
      return jsonResponse(
        { error: 'Target tray did not confirm controller', code: 'CONTROLLER_UNCONFIRMED' },
        403
      );
    }
    // Persist revocation before removing queue entries: a crash cannot replay
    // a deleted registration. The drain also checks the tombstone after restart.
    await this.state.storage.put(
      `revoked-registration:${await sha256Hex(webhookId!)}`,
      this.isoNow()
    );
    if (this.home.queue) {
      this.home.queue = this.home.queue.filter((entry) => entry.webhookId !== webhookId);
      if (this.home.queue.length === 0) delete this.home.queue;
      await this.state.storage.put(HOME_STORAGE_KEY, this.home);
    }
    return jsonResponse({ webhookId, revoked: true }, 200);
  }

  /** Retry-safe rotation changes only the delivery hash, never identity or queued work. */
  private async handleRotate(request: Request): Promise<Response> {
    let body: {
      oldSecret?: string;
      secret?: string;
      rebindSecret?: string;
      trayId?: string;
      controllerToken?: string;
    };
    try {
      body = JSON.parse(
        new TextDecoder().decode(await readBoundedWebhookBody(request))
      ) as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid body', code: 'INVALID_BODY' }, 400);
    }
    const { oldSecret, secret, rebindSecret, trayId, controllerToken } = body ?? {};
    if (
      ![oldSecret, secret, rebindSecret, trayId, controllerToken].every(
        (v) => typeof v === 'string' && v.length > 0
      )
    ) {
      return jsonResponse({ error: 'Missing required field', code: 'INVALID_BODY' }, 400);
    }
    if (
      !this.home ||
      !timingSafeEqual(await sha256Hex(rebindSecret!), this.home.rebindSecretHash)
    ) {
      return jsonResponse({ error: 'Invalid rebind capability', code: 'INVALID_REBIND' }, 403);
    }
    if (this.home.revokedAt) {
      return jsonResponse({ error: 'Webhook home revoked', code: 'HOME_REVOKED' }, 410);
    }
    const replacement = await sha256Hex(secret!);
    const receipt = await sha256Hex(JSON.stringify({ oldSecret, secret, trayId, controllerToken }));
    if (
      timingSafeEqual(this.home.secretHash, replacement) &&
      this.home.rotationReceiptHash &&
      timingSafeEqual(this.home.rotationReceiptHash, receipt)
    ) {
      // A lost response must be recoverable after source-tray expiry or a rebind.
      // This exact authenticated request already committed: no mutation or rebind.
      return jsonResponse({ coneId: this.home.coneId, rotated: true }, 200);
    }
    if (
      this.home.currentTrayId !== trayId ||
      !(await this.confirmControllerOfTray(trayId!, controllerToken!, true))
    ) {
      return jsonResponse(
        { error: 'Target tray did not confirm controller', code: 'CONTROLLER_UNCONFIRMED' },
        403
      );
    }
    if (!timingSafeEqual(this.home.secretHash, await sha256Hex(oldSecret!))) {
      return jsonResponse(
        { error: 'Invalid webhook capability', code: 'INVALID_WEBHOOK_CAPABILITY' },
        403
      );
    }
    this.home.secretHash = replacement;
    this.home.rotationReceiptHash = receipt;
    await this.state.storage.put(HOME_STORAGE_KEY, this.home);
    return jsonResponse({ coneId: this.home.coneId, rotated: true }, 200);
  }

  private async handleRevoke(request: Request): Promise<Response> {
    let body: { rebindSecret?: string };
    try {
      body = JSON.parse(
        new TextDecoder().decode(await readBoundedWebhookBody(request))
      ) as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid body', code: 'INVALID_BODY' }, 400);
    }
    if (!this.home) {
      return jsonResponse({ error: 'No such home', code: 'NOT_FOUND' }, 404);
    }
    if (typeof body?.rebindSecret !== 'string' || !body.rebindSecret) {
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
  private async confirmControllerOfTray(
    trayId: string,
    controllerToken: string,
    ownershipOnly = false
  ): Promise<boolean> {
    try {
      const stub = this.env.TRAY_HUB.get(this.env.TRAY_HUB.idFromName(trayId));
      const controller = new AbortController();
      return await withWebhookTimeout(
        (async () => {
          const res = await stub.fetch(
            new Request(
              `https://internal/internal/${ownershipOnly ? 'confirm-controller-ownership' : 'confirm-controller'}`,
              {
                method: 'POST',
                signal: controller.signal,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ controllerToken }),
              }
            )
          );
          if (res.status !== 200) {
            void res.body?.cancel().catch(() => {});
            return false;
          }
          const parsed = JSON.parse(
            new TextDecoder().decode(await readBoundedWebhookBody(res))
          ) as { confirmed?: boolean };
          return parsed.confirmed === true;
        })(),
        () => controller.abort()
      );
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
 * own headers intact. Returned as a plain record so a queued delivery can
 * persist it across a rove and replay it byte-for-byte.
 */
function forwardableDeliveryHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    if (
      key.startsWith('cf-') ||
      [
        'host',
        'content-length',
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
      ].includes(key)
    )
      continue;
    // Reserved routing headers stop here — the delivery secret and id are for
    // the home, never the leader or the cone.
    if (key === 'x-slicc-cone-secret' || key === 'x-slicc-webhook-id') continue;
    out[key] = value;
  }
  out['content-type'] = request.headers.get('content-type') ?? 'application/json';
  return out;
}
