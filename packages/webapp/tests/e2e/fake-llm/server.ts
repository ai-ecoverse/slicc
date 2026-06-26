/**
 * Deterministic fake OpenAI-compatible LLM server for E2E tests.
 *
 * Speaks the OpenAI Chat Completions wire format consumed by pi-ai's
 * `streamOpenAICompletions` (and any other OpenAI-compat client). Streams
 * scripted turns from a {@link Fixture}, with permissive CORS so a
 * browser/extension can call it directly. See `./types.ts` for the
 * fixture schema and matching rules.
 *
 * Endpoints:
 *   - `POST /v1/chat/completions` — SSE stream of OpenAI-shaped
 *     `chat.completion.chunk` events terminated by `data: [DONE]`. When
 *     the request body has `stream: false` the same content is returned
 *     as a single `chat.completion` JSON.
 *   - `GET  /v1/models` — `{ data: [{ id, object, owned_by, ... }] }`.
 *   - `POST /__reset` — test-only control endpoint that rewinds the
 *     turn cursor + request counter (same effect as
 *     {@link FakeLlmServer.reset}). Lets a Playwright retry replay the
 *     scripted fixture from the top even though the server is a
 *     long-lived `webServer` across attempts.
 *   - `OPTIONS *` — CORS preflight; every response also carries
 *     `Access-Control-Allow-Origin: *`.
 *
 * The server is stateful per process (advances a turn cursor) but
 * {@link FakeLlmServer.reset} and {@link FakeLlmServer.setFixture} make
 * a test run reproducible.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AssistantTurn, Fixture, UserMessageMatcher } from './types.js';

export type { AssistantTurn, Fixture, ToolCallFixture, UserMessageMatcher } from './types.js';

export interface FakeLlmServer {
  /** e.g. `http://127.0.0.1:54321` (no trailing slash). */
  readonly url: string;
  /** Base URL ready for the `local-llm` provider, i.e. `${url}/v1`. */
  readonly baseUrl: string;
  readonly port: number;
  close(): Promise<void>;
  /** Reset the turn cursor and request counter; fixture is preserved. */
  reset(): void;
  setFixture(fixture: Fixture): void;
  getState(): { cursor: number; requestCount: number };
}

export interface StartOptions {
  fixture: Fixture;
  /** Default `0` (random free port). */
  port?: number;
  /** Default `'127.0.0.1'`. */
  host?: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Id',
  'Access-Control-Max-Age': '86400',
};

interface ChatRequest {
  model?: string;
  messages?: Array<{ role: string; content?: unknown }>;
  stream?: boolean;
}

export async function startFakeLlmServer(opts: StartOptions): Promise<FakeLlmServer> {
  let fixture = validateFixture(opts.fixture);
  let cursor = 0;
  let requestCount = 0;
  let lastUsedTurnIndex = -1;

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // If the response already started (e.g. an SSE stream that errored
      // mid-write), the headers/body are out the door — overwriting with
      // a 500 JSON would throw `ERR_HTTP_HEADERS_SENT`. Tear the socket
      // down so the client sees a clean disconnect.
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      writeJson(res, 500, {
        error: { message: String(err?.message ?? err), type: 'server_error' },
      });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

    const method = (req.method ?? 'GET').toUpperCase();
    const url = req.url ?? '/';
    if (method === 'OPTIONS') {
      // Echo the client's requested headers when present so direct
      // browser/extension callers (e.g. pi-ai's X-Stainless-* set) pass
      // the preflight without us having to enumerate every header up
      // front. Header lookup is case-insensitive via node's lowercased
      // `req.headers` map.
      const requested = req.headers['access-control-request-headers'];
      if (typeof requested === 'string' && requested.length > 0) {
        res.setHeader('Access-Control-Allow-Headers', requested);
      }
      res.statusCode = 204;
      res.end();
      return;
    }
    if (method === 'POST' && (url === '/__reset' || url.startsWith('/__reset?'))) {
      // Test-only control endpoint: rewind the turn cursor so a
      // Playwright retry (the fake LLM is a long-lived `webServer`)
      // replays the scripted fixture from the top instead of continuing
      // past the cursor a failed attempt left behind — which would
      // otherwise fail deterministically with `fixture_overflow`. See
      // `fake-llm-helpers.ts:resetFakeLlm` + `reference-scenario.test.ts`.
      resetState();
      writeJson(res, 200, { object: 'fake_llm.reset', cursor, requestCount });
      return;
    }
    if (method === 'GET' && (url === '/v1/models' || url.startsWith('/v1/models?'))) {
      writeJson(res, 200, { object: 'list', data: modelsList(fixture) });
      return;
    }
    if (
      method === 'POST' &&
      (url === '/v1/chat/completions' || url.startsWith('/v1/chat/completions?'))
    ) {
      requestCount += 1;
      const body = await readJsonBody(req);
      const stream = body?.stream !== false;
      const latestUserMessage = extractLatestUserMessage(body);
      const picked = pickTurn(fixture, cursor, latestUserMessage);
      if (!picked) {
        writeJson(res, 400, {
          error: {
            message: `fake-llm: no eligible turn for request #${requestCount} (cursor=${cursor}, fixture has ${fixture.turns.length} turns). Latest user message: ${JSON.stringify(latestUserMessage)}`,
            type: 'fixture_overflow',
            code: 'fixture_overflow',
          },
        });
        return;
      }
      cursor = picked.nextCursor;
      lastUsedTurnIndex = picked.index;
      if (stream) await writeSseStream(res, fixture.model, picked.turn);
      else writeJson(res, 200, buildNonStreamResponse(fixture.model, picked.turn));
      return;
    }
    writeJson(res, 404, { error: { message: `Not found: ${method} ${url}`, type: 'not_found' } });
  }

  function resetState(): void {
    cursor = 0;
    requestCount = 0;
    lastUsedTurnIndex = -1;
  }

  function pickTurn(fx: Fixture, fromCursor: number, userMessage: string | null) {
    const turns = fx.turns;
    if (turns.length === 0) return overflowFallback(fx);
    const at = turns[fromCursor];
    if (at && (!at.whenUserMessageMatches || matches(at.whenUserMessageMatches, userMessage))) {
      return { turn: at, index: fromCursor, nextCursor: fromCursor + 1 };
    }
    for (let i = fromCursor + 1; i < turns.length; i++) {
      const t = turns[i];
      if (t?.whenUserMessageMatches && matches(t.whenUserMessageMatches, userMessage)) {
        return { turn: t, index: i, nextCursor: i + 1 };
      }
    }
    return overflowFallback(fx);
  }

  function overflowFallback(fx: Fixture) {
    if (fx.onOverflow === 'repeat-last' && lastUsedTurnIndex >= 0) {
      const t = fx.turns[lastUsedTurnIndex];
      if (t) return { turn: t, index: lastUsedTurnIndex, nextCursor: cursor };
    }
    return null;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const url = `http://${opts.host ?? '127.0.0.1'}:${addr.port}`;

  return {
    url,
    baseUrl: `${url}/v1`,
    port: addr.port,
    close: () => closeServer(server),
    reset: resetState,
    setFixture: (next) => {
      fixture = validateFixture(next);
      resetState();
    },
    getState: () => ({ cursor, requestCount }),
  };
}

function validateFixture(fx: Fixture): Fixture {
  if (!fx || typeof fx !== 'object') throw new Error('fake-llm: fixture must be an object');
  if (typeof fx.model !== 'string' || !fx.model)
    throw new Error('fake-llm: fixture.model required');
  if (!Array.isArray(fx.turns)) throw new Error('fake-llm: fixture.turns must be an array');
  return fx;
}

function modelsList(fx: Fixture) {
  const uniqueIds = Array.from(new Set([fx.model, ...(fx.models ?? [])]));
  const now = Math.floor(Date.now() / 1000);
  return uniqueIds.map((id) => ({ id, object: 'model', created: now, owned_by: 'fake-llm' }));
}

function matches(m: UserMessageMatcher, msg: string | null): boolean {
  if (msg == null) return false;
  if (typeof m === 'string') return msg.includes(m);
  if (m instanceof RegExp) return m.test(msg);
  if (typeof m === 'object' && typeof m.pattern === 'string') {
    return new RegExp(m.pattern, m.flags ?? '').test(msg);
  }
  return false;
}

function extractLatestUserMessage(body: ChatRequest | null): string | null {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    return flattenContent(m.content);
  }
  return null;
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: unknown) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          const part = p as { type?: string; text?: string };
          if (part.type === 'text' && typeof part.text === 'string') return part.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

async function readJsonBody(req: IncomingMessage): Promise<ChatRequest | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as ChatRequest;
  } catch {
    return null;
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections?.();
  });
}

// ── SSE writers ────────────────────────────────────────────────────

function writeSseStream(res: ServerResponse, model: string, turn: AssistantTurn): Promise<void> {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const id = `chatcmpl-fake-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (delta: Record<string, unknown>, finish: string | null) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  send({ role: 'assistant' }, null);

  for (const piece of chunkContent(turn.content ?? '', turn.contentChunkSize ?? 16)) {
    send({ content: piece }, null);
  }

  const toolCalls = turn.tool_calls ?? [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (!tc) continue;
    const argString =
      typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
    send(
      {
        tool_calls: [
          {
            index: i,
            id: tc.id ?? `call_fake_${i}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: { name: tc.name, arguments: '' },
          },
        ],
      },
      null
    );
    for (const frag of chunkContent(argString, turn.toolArgumentsChunkSize ?? 24)) {
      send({ tool_calls: [{ index: i, function: { arguments: frag } }] }, null);
    }
  }

  const finish = turn.finish_reason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');
  send({}, finish);
  res.write('data: [DONE]\n\n');
  res.end();
  return Promise.resolve();
}

function chunkContent(text: string, size: number): string[] {
  if (!text) return [];
  const step = Math.max(1, Math.floor(size));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) out.push(text.slice(i, i + step));
  return out;
}

function buildNonStreamResponse(model: string, turn: AssistantTurn): unknown {
  const toolCalls = (turn.tool_calls ?? []).map((tc, i) => ({
    id: tc.id ?? `call_fake_${i}`,
    type: 'function',
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
    },
  }));
  const finish = turn.finish_reason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');
  return {
    id: `chatcmpl-fake-${Math.random().toString(36).slice(2, 12)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: turn.content ?? null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
