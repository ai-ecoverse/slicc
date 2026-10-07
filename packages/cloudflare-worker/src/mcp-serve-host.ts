import type { DurableObjectStubLike } from './shared.js';

const BODY_CAP = 1_048_576;

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

interface McpEnvelope {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export async function tryHandleMcpHost(
  request: Request,
  stub: DurableObjectStubLike,
  token: string,
  url: URL
): Promise<Response | null> {
  try {
    return await probeMcpHost(request, stub, token, url);
  } catch {
    return null;
  }
}

async function probeMcpHost(
  request: Request,
  stub: DurableObjectStubLike,
  token: string,
  url: URL
): Promise<Response | null> {
  const encoded = await readBody(request);
  const response = await stub.fetch(
    new Request('https://internal/internal/mcp/http', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        method: request.method,
        path: url.pathname,
        search: url.search,
        body: encoded.body,
        contentType: request.headers.get('content-type') ?? '',
        authorization: request.headers.get('authorization') ?? '',
        origin: request.headers.get('origin') ?? '',
        resourceOrigin: url.origin,
        tooLarge: encoded.tooLarge,
      }),
    })
  );
  const text = await response.text();
  if (response.status === 404 && text.includes('"NOT_MCP"')) return null;
  const envelope = parseEnvelope(text);
  if (!envelope) return null;
  return new Response(visitorBody(envelope), {
    status: envelope.status,
    headers: envelope.headers,
  });
}

function visitorBody(envelope: McpEnvelope): string | null {
  return NULL_BODY_STATUS.has(envelope.status) ? null : envelope.body;
}

async function readBody(request: Request): Promise<{ body: string; tooLarge: boolean }> {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    return { body: '', tooLarge: false };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_CAP) return { body: '', tooLarge: true };
  return { body: new TextDecoder().decode(bytes), tooLarge: false };
}

function parseEnvelope(text: string): McpEnvelope | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const status = Object.getOwnPropertyDescriptor(value, 'status')?.value;
    const body = Object.getOwnPropertyDescriptor(value, 'body')?.value;
    const headers = Object.getOwnPropertyDescriptor(value, 'headers')?.value;
    if (typeof status !== 'number' || typeof body !== 'string' || !isStringRecord(headers))
      return null;
    return { status, body, headers };
  } catch {
    return null;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}
