import type { LeaderWebhookDelivery, WebhookDeliveryDisposition } from '@slicc/shared-ts';
import { jsonResponse, type TrayRecord } from './shared.js';
import { readBoundedWebhookBody, WebhookBodyError } from './webhook-body.js';

export const WEBHOOK_DELIVERY_WAIT_MS = 3_000;

export interface WebhookDeps {
  requireTray(): TrayRecord;
  matchesToken(received: string, expected: string): boolean;
  hasLiveLeader(): boolean;
  sendToLeader(message: unknown): boolean;
  isoNow(): string;
  now(): number;

  ensureTrayIsActive(): Promise<Response | null>;
}

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

  target.pathname = `${target.pathname.replace(/\/+$/, '')}/${encodeURIComponent(webhookId)}`;
  target.search = requestUrl.search;
  return target.href;
}

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

async function readWebhookBody(request: Request): Promise<unknown> {
  const bytes = await readBoundedWebhookBody(request);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
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

function forwardableHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    if (key.startsWith('cf-') || key === 'host' || key.startsWith('x-slicc-preview-')) {
      continue;
    }

    if (key === 'x-slicc-cone-secret' || key === 'x-slicc-webhook-id') {
      continue;
    }
    headers[key] = value;
  }
  return headers;
}

export class WebhookRelay {
  private readonly pending = new Map<
    string,
    (disposition: WebhookDeliveryDisposition | null) => void
  >();
  private counter = 0;

  constructor(
    private readonly deps: WebhookDeps,

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

    const superseded = this.supersededRedirect(request, webhookId, cors);
    if (superseded) return superseded;

    return this.deliver(webhookId, request, cors);
  }

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

  settle(message: LeaderWebhookDelivery): void {
    const resolve = this.pending.get(message.deliveryId);
    if (!resolve) return;
    this.pending.delete(message.deliveryId);
    resolve(message.disposition);
  }

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
