/**
 * Validation contract for `POST /api/handoff` after the x-slicc → Link cutover.
 *
 * The handler is wired inline inside index.ts so we exercise it via a small
 * standalone Express app that mirrors its shape. Keeps the test focused on
 * the validation contract — the broadcast side is exercised via an injected
 * collector that records each event the handler would push to the lick
 * WebSocket.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response } from 'express';

interface RecordedEvent {
  type: 'navigate_event';
  verb: 'handoff' | 'upskill';
  target: string;
  instruction?: string;
  url: string;
  title?: string;
  timestamp: string;
}

function makeApp(events: RecordedEvent[]) {
  const app = express();
  app.use(express.json());
  app.post('/api/handoff', (req: Request, res: Response) => {
    const payload = req.body as {
      verb?: unknown;
      target?: unknown;
      instruction?: unknown;
      url?: unknown;
      title?: unknown;
      sliccHeader?: unknown;
    };
    if (typeof payload?.sliccHeader === 'string') {
      res.status(400).json({
        error:
          'The legacy `sliccHeader` payload was removed; post `{ verb, target, instruction? }` instead. See docs/slicc-handoff.md.',
      });
      return;
    }
    if (payload?.verb !== 'handoff' && payload?.verb !== 'upskill') {
      res.status(400).json({ error: 'verb must be "handoff" or "upskill"' });
      return;
    }
    if (typeof payload.target !== 'string' || payload.target.length === 0) {
      res.status(400).json({ error: 'target is required (non-empty string)' });
      return;
    }
    if (payload.instruction != null && typeof payload.instruction !== 'string') {
      res.status(400).json({ error: 'instruction must be a string when provided' });
      return;
    }
    events.push({
      type: 'navigate_event',
      verb: payload.verb,
      target: payload.target,
      instruction: typeof payload.instruction === 'string' ? payload.instruction : undefined,
      url:
        typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : 'about:handoff',
      title: typeof payload.title === 'string' ? payload.title : undefined,
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  });
  return app;
}

async function postJson(app: express.Express, body: unknown): Promise<Response> {
  const server = app.listen(0);
  try {
    const addr = server.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    return await fetch(`http://localhost:${addr.port}/api/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('POST /api/handoff', () => {
  let events: RecordedEvent[];
  let app: express.Express;

  beforeEach(() => {
    events = [];
    app = makeApp(events);
  });

  it('accepts a handoff payload and broadcasts a navigate_event', async () => {
    const res = await postJson(app, {
      verb: 'handoff',
      target: 'https://example.com/page',
      instruction: 'Continue the signup flow',
      url: 'https://example.com/page',
      title: 'Signup',
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'navigate_event',
      verb: 'handoff',
      target: 'https://example.com/page',
      instruction: 'Continue the signup flow',
      url: 'https://example.com/page',
      title: 'Signup',
    });
  });

  it('accepts an upskill payload without instruction', async () => {
    const res = await postJson(app, {
      verb: 'upskill',
      target: 'https://github.com/slicc/skills-extra',
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verb: 'upskill',
      target: 'https://github.com/slicc/skills-extra',
    });
    expect(events[0].instruction).toBeUndefined();
  });

  it('rejects the legacy { sliccHeader } payload with a clear error', async () => {
    const res = await postJson(app, { sliccHeader: 'handoff:do something', url: 'about:x' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('sliccHeader');
    expect(body.error).toContain('verb');
    expect(events).toHaveLength(0);
  });

  it('rejects an unknown verb', async () => {
    const res = await postJson(app, { verb: 'launch', target: 'https://x.example/' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('verb must be');
    expect(events).toHaveLength(0);
  });

  it('rejects a missing target', async () => {
    const res = await postJson(app, { verb: 'handoff' });
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
  });

  it('rejects a non-string instruction', async () => {
    const res = await postJson(app, {
      verb: 'handoff',
      target: 'https://x.example/',
      instruction: 123,
    });
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
  });
});
