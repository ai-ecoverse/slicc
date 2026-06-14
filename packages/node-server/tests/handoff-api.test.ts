/**
 * Validation contract for `POST /api/handoff` after the x-slicc → Link cutover.
 *
 * Exercises the real route registrar from src/routes/handoff.ts via a small
 * standalone Express app. The broadcast side is captured through an injected
 * collector that records each navigate event the handler pushes to the lick
 * WebSocket.
 */

import express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { type NavigateEvent, registerHandoffRoute } from '../src/routes/handoff.js';

type RecordedEvent = NavigateEvent;

function makeApp(events: RecordedEvent[]) {
  const app = express();
  app.use(express.json());
  registerHandoffRoute(app, {
    broadcastLickEvent: (event) => {
      events.push(event as RecordedEvent);
    },
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

  it('accepts an upskill payload with branch and path', async () => {
    const res = await postJson(app, {
      verb: 'upskill',
      target: 'https://github.com/o/r',
      branch: 'main',
      path: 'skills/foo',
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verb: 'upskill',
      target: 'https://github.com/o/r',
      branch: 'main',
      path: 'skills/foo',
    });
  });

  it('rejects branch on the handoff verb (upskill-only)', async () => {
    const res = await postJson(app, {
      verb: 'handoff',
      target: 'https://example.com/',
      branch: 'main',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('upskill');
    expect(events).toHaveLength(0);
  });

  it('rejects path on the handoff verb (upskill-only)', async () => {
    const res = await postJson(app, {
      verb: 'handoff',
      target: 'https://example.com/',
      path: 'skills/foo',
    });
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
  });

  it('rejects a non-string branch', async () => {
    const res = await postJson(app, {
      verb: 'upskill',
      target: 'https://github.com/o/r',
      branch: 123,
    });
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
  });

  it('rejects a non-string path', async () => {
    const res = await postJson(app, {
      verb: 'upskill',
      target: 'https://github.com/o/r',
      path: ['skills', 'foo'],
    });
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
  });
});
