import type { WebhookDeliveryDisposition } from '@slicc/shared-ts';
import type { Express, Response } from 'express';
import type { LickBridge } from './lick-bridge.js';

function respondBrowserUnavailable(res: Response, err: unknown): void {
  res.status(503).json({ error: err instanceof Error ? err.message : 'Browser not connected' });
}

type WebhookDeliveryOutcome = WebhookDeliveryDisposition | 'malformed' | 'failed' | 'unknown';

const WEBHOOK_OUTCOMES: readonly WebhookDeliveryOutcome[] = [
  'delivered',
  'filtered',
  'unknown-webhook',
  'unresolved-target',
  'malformed',
  'failed',
];

function readDisposition(reply: unknown): WebhookDeliveryOutcome {
  const value = (reply as { disposition?: unknown } | null)?.disposition;
  return WEBHOOK_OUTCOMES.find((outcome) => outcome === value) ?? 'unknown';
}

function respondWebhookDisposition(
  res: Response,
  webhookId: string,
  outcome: WebhookDeliveryOutcome
): void {
  if (outcome === 'delivered' || outcome === 'filtered' || outcome === 'unknown') {
    res.json({ ok: true, received: true });
    return;
  }
  if (outcome === 'unknown-webhook') {
    res.status(404).json({
      ok: false,
      received: false,
      error: `Webhook "${webhookId}" is not registered`,
      code: 'WEBHOOK_NOT_REGISTERED',
    });
    return;
  }
  if (outcome === 'unresolved-target') {
    res.status(422).json({
      ok: false,
      received: false,
      error: `Webhook "${webhookId}" targets a scoop or cone that no longer exists — the event was dropped`,
      code: 'WEBHOOK_TARGET_UNRESOLVED',
    });
    return;
  }
  res.status(500).json({
    ok: false,
    received: false,
    error: `Webhook "${webhookId}" could not be dispatched (${outcome})`,
    code: 'WEBHOOK_DISPATCH_FAILED',
  });
}

export function registerLickApiRoutes(app: Express, bridge: LickBridge): void {
  const { sendLickRequest, broadcastLickEvent } = bridge;

  app.get('/api/tray-status', async (_req, res) => {
    try {
      const data = await sendLickRequest('tray_status', {});
      res.json(data);
    } catch (err) {
      respondBrowserUnavailable(res, err);
    }
  });

  app.get('/api/webhooks', async (_req, res) => {
    try {
      const data = await sendLickRequest('list_webhooks', {});
      res.json(data);
    } catch (err) {
      respondBrowserUnavailable(res, err);
    }
  });

  app.post('/api/webhooks', async (req, res) => {
    try {
      const data = await sendLickRequest('create_webhook', req.body);
      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.includes('Invalid') ? 400 : 503).json({ error: msg });
    }
  });

  app.delete('/api/webhooks/:id', async (req, res) => {
    try {
      const data = (await sendLickRequest('delete_webhook', { id: req.params.id })) as {
        ok?: boolean;
        error?: string;
      };
      if (data.error) {
        res.status(404).json({ error: data.error });
      } else {
        res.json(data);
      }
    } catch (err) {
      respondBrowserUnavailable(res, err);
    }
  });

  app.options('/webhooks/:id', (_req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.sendStatus(204);
  });

  app.post('/webhooks/:id', async (req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*' });
    const { id } = req.params;

    let body = req.body;
    if (!body || Object.keys(body).length === 0) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        body = JSON.parse(raw);
      } catch {
        body = { raw };
      }
    }

    const event = {
      type: 'webhook_event',
      webhookId: id,
      timestamp: new Date().toISOString(),
      headers: req.headers,
      body,
    };
    let disposition: WebhookDeliveryOutcome;
    try {
      disposition = readDisposition(await sendLickRequest('webhook_event', event));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes('Unknown request type')) {
        broadcastLickEvent(event);
        res.json({ ok: true, received: true });
        return;
      }
      res.status(503).json({ ok: false, received: false, error: msg, code: 'BROWSER_UNAVAILABLE' });
      return;
    }
    respondWebhookDisposition(res, id, disposition);
  });

  app.get('/api/crontasks', async (_req, res) => {
    try {
      const data = await sendLickRequest('list_crontasks', {});
      res.json(data);
    } catch (err) {
      respondBrowserUnavailable(res, err);
    }
  });

  app.post('/api/crontasks', async (req, res) => {
    try {
      const data = await sendLickRequest('create_crontask', req.body);
      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res
        .status(msg.includes('Invalid') || msg.includes('required') ? 400 : 503)
        .json({ error: msg });
    }
  });

  app.delete('/api/crontasks/:id', async (req, res) => {
    try {
      const data = (await sendLickRequest('delete_crontask', { id: req.params.id })) as {
        ok?: boolean;
        error?: string;
      };
      if (data.error) {
        res.status(404).json({ error: data.error });
      } else {
        res.json(data);
      }
    } catch (err) {
      respondBrowserUnavailable(res, err);
    }
  });
}
