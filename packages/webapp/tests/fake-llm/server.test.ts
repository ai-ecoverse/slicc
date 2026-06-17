/**
 * Unit tests for the fake OpenAI-compatible LLM server used by the E2E
 * harness. The server itself lives under `tests/e2e/fake-llm/` because
 * it's a test-only artifact; the tests live here so the webapp vitest
 * project picks them up (`tests/e2e/**` is excluded from `npm run test`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type FakeLlmServer,
  type Fixture,
  startFakeLlmServer,
} from '../../tests/e2e/fake-llm/server.js';

let server: FakeLlmServer;

async function start(fixture: Fixture): Promise<FakeLlmServer> {
  server = await startFakeLlmServer({ fixture, port: 0 });
  return server;
}

afterEach(async () => {
  await server?.close();
});

/** Parse an OpenAI-shape SSE stream into typed events. */
async function readSse(res: Response): Promise<{
  events: Array<Record<string, unknown>>;
  done: boolean;
}> {
  const text = await res.text();
  const events: Array<Record<string, unknown>> = [];
  let done = false;
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n').filter((l) => l.startsWith('data:'));
    for (const line of lines) {
      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        done = true;
        continue;
      }
      if (!payload) continue;
      events.push(JSON.parse(payload));
    }
  }
  return { events, done };
}

function userTurnBody(content: string, opts: { stream?: boolean; model?: string } = {}) {
  return {
    model: opts.model ?? 'fake-coder',
    stream: opts.stream ?? true,
    messages: [{ role: 'user', content }],
  };
}

describe('startFakeLlmServer — boot + endpoints', () => {
  it('binds to a random port and serves /v1/models in OpenAI shape', async () => {
    await start({ model: 'fake-coder', models: ['fake-mini'], turns: [] });
    const res = await fetch(`${server.url}/v1/models`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toEqual(['fake-coder', 'fake-mini']);
  });

  it('responds 204 with CORS headers to OPTIONS preflight', async () => {
    await start({ model: 'fake', turns: [] });
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('echoes Access-Control-Request-Headers into Access-Control-Allow-Headers when present', async () => {
    await start({ model: 'fake', turns: [] });
    const requested = 'x-stainless-os, x-stainless-arch';
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': requested,
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toBe(requested);
  });

  it('returns 404 JSON for unknown routes', async () => {
    await start({ model: 'fake', turns: [] });
    const res = await fetch(`${server.url}/v1/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.type).toBe('not_found');
  });
});

describe('POST /v1/chat/completions — streaming SSE', () => {
  beforeEach(async () => {
    await start({
      model: 'fake-coder',
      turns: [
        { content: 'Hello there!', contentChunkSize: 5 },
        {
          tool_calls: [{ name: 'bash', arguments: { command: 'ls' } }],
          toolArgumentsChunkSize: 6,
        },
        { content: 'done' },
      ],
    });
  });

  it('streams a text turn as valid OpenAI SSE deltas ending with [DONE]', async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userTurnBody('hi')),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const { events, done } = await readSse(res);
    expect(done).toBe(true);

    expect(events[0]).toMatchObject({
      object: 'chat.completion.chunk',
      model: 'fake-coder',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
    const textChunks = events
      .map((e) => {
        const choices = e['choices'] as Array<{ delta: { content?: string } }>;
        return choices[0]?.delta.content;
      })
      .filter((c): c is string => typeof c === 'string');
    expect(textChunks.join('')).toBe('Hello there!');
    expect(textChunks.length).toBeGreaterThan(1);
    const finish = events.at(-1) as { choices: Array<{ finish_reason: string }> };
    expect(finish.choices[0]?.finish_reason).toBe('stop');
  });

  it('streams tool_calls as a name-then-arguments fragment chain', async () => {
    await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userTurnBody('first')),
    });
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userTurnBody('run it')),
    });
    const { events } = await readSse(res);

    type ToolDelta = {
      index: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    };
    const toolDeltas: ToolDelta[] = [];
    for (const e of events) {
      const choices = e['choices'] as Array<{ delta: { tool_calls?: ToolDelta[] } }>;
      const calls = choices[0]?.delta.tool_calls;
      if (calls) toolDeltas.push(...calls);
    }
    expect(toolDeltas.length).toBeGreaterThan(1);
    const head = toolDeltas[0];
    expect(head?.function?.name).toBe('bash');
    expect(head?.type).toBe('function');
    expect(head?.id).toMatch(/^call_/);
    expect(head?.function?.arguments).toBe('');

    const reconstructed = toolDeltas.map((d) => d.function?.arguments ?? '').join('');
    expect(JSON.parse(reconstructed)).toEqual({ command: 'ls' });

    const last = events.at(-1) as { choices: Array<{ finish_reason: string }> };
    expect(last.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('advances the turn cursor across sequential requests', async () => {
    const responses = await Promise.all(
      ['a', 'b', 'c'].map((m) =>
        fetch(`${server.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(userTurnBody(m)),
        })
      )
    );
    // Sequential cursor advance: parse text contents in order.
    const allEvents = await Promise.all(responses.map((r) => readSse(r)));
    const joined = allEvents.map(({ events }) =>
      events
        .map((e) => {
          const choices = e['choices'] as Array<{ delta: { content?: string } }>;
          return choices[0]?.delta.content ?? '';
        })
        .join('')
    );
    expect(joined).toEqual(['Hello there!', '', 'done']);
    expect(server.getState()).toEqual({ cursor: 3, requestCount: 3 });
  });
});

describe('matching + overflow', () => {
  it('uses whenUserMessageMatches (string substring) to pick later turns and skip non-matching ones', async () => {
    await start({
      model: 'fake',
      turns: [
        { whenUserMessageMatches: 'login', content: 'doing login' },
        { whenUserMessageMatches: 'logout', content: 'doing logout' },
      ],
    });
    const r = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userTurnBody('please logout now')),
    });
    const { events } = await readSse(r);
    const content = events
      .map((e) => {
        const ch = e['choices'] as Array<{ delta: { content?: string } }>;
        return ch[0]?.delta.content ?? '';
      })
      .join('');
    expect(content).toBe('doing logout');
    // The first (login) turn was skipped, not used — cursor sits past 'logout'.
    expect(server.getState().cursor).toBe(2);
  });

  it('supports regex matchers via object form (JSON-friendly)', async () => {
    await start({
      model: 'fake',
      turns: [{ whenUserMessageMatches: { pattern: '^hi\\b', flags: 'i' }, content: 'hello' }],
    });
    const r = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userTurnBody('Hi there')),
    });
    expect(r.status).toBe(200);
    const { events, done } = await readSse(r);
    expect(done).toBe(true);
    const content = events
      .map((e) => {
        const ch = e['choices'] as Array<{ delta: { content?: string } }>;
        return ch[0]?.delta.content ?? '';
      })
      .join('');
    expect(content).toBe('hello');
  });

  it('returns a 400 fixture_overflow when no turn matches (default)', async () => {
    await start({
      model: 'fake',
      turns: [{ whenUserMessageMatches: 'login', content: 'x' }],
    });
    const r = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userTurnBody('something else')),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { type: string; code: string; message: string } };
    expect(body.error.code).toBe('fixture_overflow');
    expect(body.error.message).toContain('no eligible turn');
  });

  it('repeats the last used turn when onOverflow=repeat-last', async () => {
    await start({
      model: 'fake',
      turns: [{ content: 'only' }],
      onOverflow: 'repeat-last',
    });
    const a = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userTurnBody('first')),
    });
    const b = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userTurnBody('second')),
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const aText = await readSse(a);
    const bText = await readSse(b);
    const join = (ev: { events: Array<Record<string, unknown>> }) =>
      ev.events
        .map((e) => {
          const ch = e['choices'] as Array<{ delta: { content?: string } }>;
          return ch[0]?.delta.content ?? '';
        })
        .join('');
    expect(join(aText)).toBe('only');
    expect(join(bText)).toBe('only');
  });
});

describe('non-streaming + reset + setFixture', () => {
  it('returns a single chat.completion JSON when stream:false', async () => {
    await start({
      model: 'fake-coder',
      turns: [
        {
          content: 'sync ok',
          tool_calls: [{ id: 'call_pinned', name: 'noop', arguments: '{}' }],
        },
      ],
    });
    const r = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userTurnBody('go', { stream: false })),
    });
    expect(r.headers.get('content-type')).toContain('application/json');
    const body = (await r.json()) as {
      object: string;
      model: string;
      choices: Array<{
        message: {
          content: string;
          tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
      }>;
    };
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('fake-coder');
    expect(body.choices[0]?.message.content).toBe('sync ok');
    expect(body.choices[0]?.message.tool_calls[0]).toMatchObject({
      id: 'call_pinned',
      function: { name: 'noop', arguments: '{}' },
    });
    expect(body.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('reset() rewinds the cursor and setFixture() swaps the script', async () => {
    await start({
      model: 'fake',
      turns: [{ content: 'first' }, { content: 'second' }],
    });
    await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userTurnBody('a')),
    });
    expect(server.getState().cursor).toBe(1);

    server.reset();
    expect(server.getState()).toEqual({ cursor: 0, requestCount: 0 });

    server.setFixture({ model: 'fake-v2', turns: [{ content: 'reloaded' }] });
    const r = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userTurnBody('a')),
    });
    const { events } = await readSse(r);
    const content = events
      .map((e) => {
        const ch = e['choices'] as Array<{ delta: { content?: string } }>;
        return ch[0]?.delta.content ?? '';
      })
      .join('');
    expect(content).toBe('reloaded');
    const models = (await (await fetch(`${server.url}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    expect(models.data.map((m) => m.id)).toEqual(['fake-v2']);
  });
});
