/**
 * Webhook relay for the tray durable object.
 *
 * An external service POSTs `/webhook/:webhookToken/:webhookId`; the DO relays
 * the event to the leader over the control socket and waits (briefly) for the
 * leader's `webhook.delivery` so the HTTP receipt reflects what actually
 * happened to the event (issue #2524).
 *
 * Extracted from `session-tray.ts` behind a {@link WebhookDeps} seam, like
 * `session-tray-preview.ts` / `session-tray-biscotto.ts`. A class rather than
 * free functions because the pending-delivery map and the delivery-id counter
 * are per-DO-instance state that belongs with this concern, not on the DO.
 */

import type { LeaderWebhookDelivery, WebhookDeliveryDisposition } from '@slicc/shared-ts';
import { jsonResponse, type TrayRecord } from './shared.js';
import { readBoundedWebhookBody, WebhookBodyError } from './webhook-body.js';

/**
 * How long a webhook POST waits for the leader's `webhook.delivery` before the
 * receipt falls back to the pre-#2524 `202 accepted`. Short on purpose: the
 * leader's answer is synchronous once the message lands, and the caller is an
 * external service on a request budget of its own.
 */
export const WEBHOOK_DELIVERY_WAIT_MS = 3_000;

/** The slice of the durable object this relay needs. */
export interface WebhookDeps {
  requireTray(): TrayRecord;
  matchesToken(received: string, expected: string): boolean;
  hasLiveLeader(): boolean;
  sendToLeader(message: unknown): boolean;
  isoNow(): string;
  now(): number;
  /**
   * The expiry gate the DO applies to every other capability route, called
   * here instead of before dispatch so a superseded tray can answer a delivery
   * with a redirect rather than the 410 that gate would return first.
   */
  ensureTrayIsActive(): Promise<Response | null>;
}

/**
 * `Location` for a webhook delivery to a superseded tray: the replacement's
 * webhook capability URL, with this delivery's `webhookId` and query string
 * carried over so the redirect names the same event on the new tray.
 *
 * Returns null when the stored replacement does not parse, in which case the
 * caller keeps the terminal response — a 3xx with no target is worse than the
 * 410 it replaced.
 */
export function supersededWebhookLocation(
  webhookBaseUrl: string,
  webhookId: string,
  requestUrl: URL
): string | null {
  let target: URL;
  try {
    target = new URL(webhookBaseUrl);
  } catch {
    return null;
  }
  // The base is `/webhook/:token`; a delivery is `/webhook/:token/:webhookId`.
  target.pathname = `${target.pathname.replace(/\/+$/, '')}/${encodeURIComponent(webhookId)}`;
  target.search = requestUrl.search;
  return target.href;
}

/**
 * Turn the leader's disposition into the webhook POST's receipt. `delivered`,
 * `filtered` and "no answer" all keep the pre-#2524 `202 accepted` — a
 * `--filter` dropping an event is the filter doing its job, and silence is not
 * evidence of a drop. The other two used to be reported as success too, which
 * made a black-holed webhook indistinguishable from a healthy one.
 */
export function webhookDeliveryResponse(
  webhookId: string,
  disposition: WebhookDeliveryDisposition | null
): Response {
  const cors = { 'access-control-allow-origin': '*' };
  if (disposition === 'unknown-webhook') {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: `Webhook "${webhookId}" is not registered with this leader`,
        code: 'WEBHOOK_NOT_REGISTERED',
      },
      404,
      cors
    );
  }
  if (disposition === 'unresolved-target') {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: `Webhook "${webhookId}" targets a scoop or cone that does not exist — the event was dropped`,
        code: 'WEBHOOK_TARGET_UNRESOLVED',
      },
      422,
      cors
    );
  }
  return jsonResponse(
    { ok: true, accepted: true },
    202,
    disposition === 'delivered' || disposition === 'filtered'
      ? { ...cors, 'x-slicc-webhook-ack': disposition }
      : cors
  );
}

/**
 * Read the POST body as JSON where possible, falling back to `{ raw: text }`
 * so a plain-text or form payload still reaches the cone instead of 400ing.
 */
async function readWebhookBody(request: Request): Promise<unknown> {
  const bytes = await readBoundedWebhookBody(request);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // JSON control messages cannot carry arbitrary bytes directly. Base64 is
    // lossless (unlike the replacement characters from Request.text()).
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { raw: btoa(binary), encoding: 'base64' };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Forwardable request headers. Cloudflare-internal headers and `host` are
 * noise; the reserved `x-slicc-preview-*` headers are how the DO attributes a
 * bridge-WS emit to a specific preview tab (rendered as a trusted "Preview
 * Event"). Only the DO's own emit path may set them — a public webhook POST
 * carrying them would otherwise forge tab attribution into the cone.
 */
function forwardableHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    if (key.startsWith('cf-') || key === 'host' || key.startsWith('x-slicc-preview-')) {
      continue;
    }
    // Reserved WebhookHome routing headers (#2812): the cone delivery secret
    // and webhook id are consumed by the home, and must never reach the cone
    // — a public POST carrying them would otherwise forge them onto the event.
    if (key === 'x-slicc-cone-secret' || key === 'x-slicc-webhook-id') {
      continue;
    }
    headers[key] = value;
  }
  return headers;
}

export class WebhookRelay {
  /**
   * Webhook POSTs whose HTTP response is waiting on the leader's disposition,
   * keyed by deliveryId. Populated by {@link handle}; drained by {@link settle}
   * when the leader answers, or by the wait budget.
   */
  private readonly pending = new Map<
    string,
    (disposition: WebhookDeliveryDisposition | null) => void
  >();
  private counter = 0;

  constructor(
    private readonly deps: WebhookDeps,
    /**
     * Ack budget override (tests). A fake leader that never acks would
     * otherwise sit out the full production budget.
     */
    private readonly waitMs: number = WEBHOOK_DELIVERY_WAIT_MS
  ) {}

  async handle(token: string, request: Request, webhookId?: string): Promise<Response> {
    const cors = { 'access-control-allow-origin': '*' };
    if (!this.deps.matchesToken(token, this.deps.requireTray().webhookToken)) {
      return jsonResponse(
        { error: 'Invalid webhook capability', code: 'INVALID_WEBHOOK_CAPABILITY' },
        403,
        cors
      );
    }

    if (!webhookId) {
      return jsonResponse(
        {
          error: 'Webhook ID is required. Use POST /webhook/{token}/{webhookId}',
          code: 'WEBHOOK_ID_REQUIRED',
        },
        400,
        cors
      );
    }

    // Checked after the capability token and before the expiry gate, mirroring
    // the join surface. After the token because `Location` names the
    // replacement's webhook capability — an unauthenticated redirect would hand
    // that secret to anyone who guessed a tray id. Before expiry because a
    // superseded tray is the more actionable answer, and it is what stops an
    // external service's cached callback URL from dying with the tray (#1957).
    const superseded = this.supersededRedirect(request, webhookId, cors);
    if (superseded) return superseded;

    return this.deliver(webhookId, request, cors);
  }

  /**
   * Deliver a webhook forwarded INTERNALLY by a WebhookHome DO (#2812). The
   * home already verified the cone-scoped delivery secret and resolved this
   * tray as the current one, so there is no public token to check and no
   * supersede redirect to answer — the home indirection replaces both. Runs
   * the same expiry / live-leader / relay path a public delivery runs.
   *
   * Reachable only through the DO stub (the `/internal/*` routes never leave
   * the worker), so skipping the token check does not widen the attack surface:
   * an external caller can never address this route directly.
   */
  async handleInternal(webhookId: string, request: Request): Promise<Response> {
    const cors = { 'access-control-allow-origin': '*' };
    if (!webhookId) {
      return jsonResponse(
        { error: 'Webhook ID is required', code: 'WEBHOOK_ID_REQUIRED' },
        400,
        cors
      );
    }
    return this.deliver(webhookId, request, cors);
  }

  /** Shared tail of `handle` and `handleInternal`: expiry → live-leader → relay. */
  private async deliver(
    webhookId: string,
    request: Request,
    cors: Record<string, string>
  ): Promise<Response> {
    const expired = await this.deps.ensureTrayIsActive();
    if (expired) return expired;

    if (!this.deps.hasLiveLeader()) {
      return jsonResponse(
        { error: 'No live leader is connected for this tray', code: 'NO_LIVE_LEADER' },
        410,
        cors
      );
    }

    let body: unknown;
    try {
      body = await readWebhookBody(request);
    } catch (error) {
      if (!(error instanceof WebhookBodyError)) throw error;
      return jsonResponse(
        { error: error.message, code: 'WEBHOOK_BODY_REJECTED' },
        error.status,
        cors
      );
    }
    const headers = forwardableHeaders(request);

    // Forward to leader via the control WebSocket, asking for the disposition
    // so a dropped delivery does not get a success receipt (issue #2524).
    const deliveryId = `wd-${++this.counter}-${this.deps.now()}`;
    const settled = new Promise<WebhookDeliveryDisposition | null>((resolve) => {
      this.pending.set(deliveryId, resolve);
    });
    const sent = this.deps.sendToLeader({
      type: 'webhook.event',
      webhookId,
      headers,
      body,
      timestamp: this.deps.isoNow(),
      deliveryId,
    });

    if (!sent) {
      this.pending.delete(deliveryId);
      return jsonResponse(
        { error: 'Failed to forward webhook to leader', code: 'LEADER_SEND_FAILED' },
        502,
        cors
      );
    }

    const disposition = await this.awaitDelivery(deliveryId, settled);
    return webhookDeliveryResponse(webhookId, disposition);
  }

  /**
   * The 308 that sends a delivery to the tray that replaced this one, or null
   * when this tray was not superseded (or was superseded by a leader that named
   * no webhook URL, which keeps the pre-#1957 410).
   *
   * 308 because every HTTP client follows it with the method and body intact —
   * which is the whole point here. The sender is an external service, not a
   * SLICC follower: it will never read a `successor-version` link, and a
   * non-2xx it treats as fire-and-forget is exactly how a delivery goes missing
   * with nothing reporting an error.
   */
  private supersededRedirect(
    request: Request,
    webhookId: string,
    cors: Record<string, string>
  ): Response | null {
    const replacement = this.deps.requireTray().supersededByWebhookUrl;
    if (!replacement) return null;
    const location = supersededWebhookLocation(replacement, webhookId, new URL(request.url));
    if (!location) return null;
    return jsonResponse(
      {
        error: 'This tray was superseded; the delivery was redirected to its replacement',
        code: 'TRAY_SUPERSEDED',
        webhookUrl: location,
      },
      308,
      { ...cors, Location: location }
    );
  }

  /** Hand a leader-reported disposition to the waiting webhook POST, if any. */
  settle(message: LeaderWebhookDelivery): void {
    const resolve = this.pending.get(message.deliveryId);
    if (!resolve) return;
    this.pending.delete(message.deliveryId);
    resolve(message.disposition);
  }

  /**
   * Wait out the leader's `webhook.delivery` for `deliveryId`, resolving `null`
   * once the wait budget passes. A leader that predates #2524 never answers, so
   * `null` must keep the pre-#2524 receipt: we know the event was forwarded,
   * and nothing more.
   */
  private awaitDelivery(
    deliveryId: string,
    settled: Promise<WebhookDeliveryDisposition | null>
  ): Promise<WebhookDeliveryDisposition | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      settled,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.waitMs);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      this.pending.delete(deliveryId);
    });
  }
}
