import type { Express, Response } from 'express';
import type { LickBridge } from './lick-bridge.js';

/** 503 with the underlying message, or the standard "Browser not connected". */
function respondBrowserUnavailable(res: Response, err: unknown): void {
  res.status(503).json({ error: err instanceof Error ? err.message : 'Browser not connected' });
}

/**
 * Routes that forward to the connected browser over the lick bridge:
 * tray status, webhook management + receiver, and cron task management.
 */
export function registerLickApiRoutes(app: Express, bridge: LickBridge): void {
  const { sendLickRequest, broadcastLickEvent } = bridge;

  // Tray status API — forwards to browser to get leader tray join info
  app.get('/api/tray-status', async (_req, res) => {
    try {
      const data = await sendLickRequest('tray_status', {});
      res.json(data);
    } catch (err) {
      respondBrowserUnavailable(res, err);
    }
  });

  // Webhook management API — forwards to browser
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

  // Webhook receiver — handle CORS preflight
  app.options('/webhooks/:id', (_req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.sendStatus(204);
  });

  // Webhook receiver — forwards POST to browser for processing
  app.post('/webhooks/:id', async (req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*' });
    const { id } = req.params;

    // Collect body
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

    // Forward to browser for processing
    broadcastLickEvent({
      type: 'webhook_event',
      webhookId: id,
      timestamp: new Date().toISOString(),
      headers: req.headers,
      body,
    });

    res.json({ ok: true, received: true });
  });

  // Cron task management API — forwards to browser
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
