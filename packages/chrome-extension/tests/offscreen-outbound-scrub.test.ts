import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installOutboundScrubber,
  type OutboundScrubSecretsSnapshot,
  shouldScrubUrl,
} from '../src/offscreen-outbound-scrub.js';

const OWN_ORIGIN = 'chrome-extension://test-id';

function snapshot(
  entries: Array<{ name: string; value: string; domains: string[] }>
): OutboundScrubSecretsSnapshot {
  return { sessionId: 'session-fixed', entries };
}

describe('shouldScrubUrl', () => {
  it('returns true for cross-origin https URLs', () => {
    expect(shouldScrubUrl('https://api.example.com/v1', OWN_ORIGIN)).toBe(true);
  });
  it('returns true for cross-origin http URLs', () => {
    expect(shouldScrubUrl('http://api.example.com/v1', OWN_ORIGIN)).toBe(true);
  });
  it('returns false for same-origin requests', () => {
    expect(shouldScrubUrl(`${OWN_ORIGIN}/offscreen.html`, OWN_ORIGIN)).toBe(false);
  });
  it('returns false for non-http(s) schemes', () => {
    expect(shouldScrubUrl('chrome-extension://other-id/x', OWN_ORIGIN)).toBe(false);
    expect(shouldScrubUrl('blob:https://example.com/abc', OWN_ORIGIN)).toBe(false);
    expect(shouldScrubUrl('data:text/plain,hello', OWN_ORIGIN)).toBe(false);
    expect(shouldScrubUrl('ws://example.com', OWN_ORIGIN)).toBe(false);
  });
  it('returns false for relative paths (treated as same-origin)', () => {
    expect(shouldScrubUrl('/relative/path', OWN_ORIGIN)).toBe(false);
  });
  it('returns false for malformed URLs', () => {
    expect(shouldScrubUrl('not-a-url://', OWN_ORIGIN)).toBe(false);
  });
});

describe('installOutboundScrubber', () => {
  let originalFetch: typeof globalThis.fetch;
  let baseFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Default upstream stub: 200 with an empty body. Tests that need a
    // specific shape (SSE etc.) override per-call.
    baseFetch = vi.fn(async () => new Response('ok', { status: 200 }));
  });

  function install(
    entries: Array<{ name: string; value: string; domains: string[] }>,
    getSnapshot?: () => Promise<OutboundScrubSecretsSnapshot>
  ) {
    return installOutboundScrubber({
      fetch: baseFetch as unknown as typeof globalThis.fetch,
      getSnapshot: getSnapshot ?? (async () => snapshot(entries)),
      ownOrigin: OWN_ORIGIN,
    });
  }

  function restore(): void {
    globalThis.fetch = originalFetch;
  }

  it('scrubs a real value out of a string body on a cross-origin POST', async () => {
    const handle = install([{ name: 'OPENAI_KEY', value: 'sk-real-12345', domains: ['*'] }]);
    try {
      await globalThis.fetch('https://api.example.com/v1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'see sk-real-12345 here' }),
      });
      expect(baseFetch).toHaveBeenCalledTimes(1);
      const sentInit = baseFetch.mock.calls[0][1] as RequestInit;
      const body = sentInit.body as string;
      expect(typeof body).toBe('string');
      expect(body).not.toContain('sk-real-12345');
      // Masked value is deterministic for {sessionId, name, value} — assert
      // shape rather than the exact bytes (matches secret-masking.ts crypto).
      expect(body).toMatch(/"prompt":"see sk-[a-f0-9]+ here"/);
    } finally {
      handle.uninstall();
      restore();
    }
  });

  it('scrubs real values out of header values', async () => {
    const handle = install([{ name: 'TOKEN', value: 'tok-real-abc', domains: ['*'] }]);
    try {
      await globalThis.fetch('https://api.example.com/v1', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-real-abc' },
      });
      expect(baseFetch).toHaveBeenCalledTimes(1);
      const sentInit = baseFetch.mock.calls[0][1] as RequestInit;
      const h = new Headers(sentInit.headers);
      const auth = h.get('authorization') ?? '';
      expect(auth).not.toContain('tok-real-abc');
      // `tok-real-abc` has no known prefix in `KNOWN_PREFIXES`, so the
      // full 12-char value masks to 12 hex chars. Bearer space survives.
      expect(auth).toMatch(/^Bearer [a-f0-9]{12}$/);
    } finally {
      handle.uninstall();
      restore();
    }
  });

  it('passes through same-origin requests unchanged', async () => {
    const handle = install([{ name: 'TOKEN', value: 'tok-real-abc', domains: ['*'] }]);
    try {
      const body = JSON.stringify({ x: 'tok-real-abc' });
      await globalThis.fetch(`${OWN_ORIGIN}/internal`, {
        method: 'POST',
        body,
      });
      expect(baseFetch).toHaveBeenCalledTimes(1);
      const sentInit = baseFetch.mock.calls[0][1] as RequestInit;
      // Same-origin: scrub is bypassed — body bytes reach baseFetch unchanged.
      expect(sentInit.body).toBe(body);
    } finally {
      handle.uninstall();
      restore();
    }
  });

  it('passes through non-http(s) URLs (chrome-extension, data, blob)', async () => {
    const handle = install([{ name: 'TOKEN', value: 'tok-real-abc', domains: ['*'] }]);
    try {
      await globalThis.fetch('chrome-extension://other-id/x', {
        body: 'tok-real-abc',
      });
      expect(baseFetch).toHaveBeenCalledTimes(1);
      const sentInit = baseFetch.mock.calls[0][1] as RequestInit;
      expect(sentInit.body).toBe('tok-real-abc');
    } finally {
      handle.uninstall();
      restore();
    }
  });

  it('passes through when the snapshot has no secrets', async () => {
    const handle = install([]);
    try {
      const body = JSON.stringify({ x: 'anything' });
      await globalThis.fetch('https://api.example.com/v1', { method: 'POST', body });
      expect(baseFetch).toHaveBeenCalledTimes(1);
      const sentInit = baseFetch.mock.calls[0][1] as RequestInit;
      expect(sentInit.body).toBe(body);
    } finally {
      handle.uninstall();
      restore();
    }
  });

  it('passes through (does not throw) when the snapshot RPC fails', async () => {
    const handle = install([], async () => {
      throw new Error('rpc-down');
    });
    try {
      const body = JSON.stringify({ x: 'tok-real-abc' });
      await globalThis.fetch('https://api.example.com/v1', { method: 'POST', body });
      expect(baseFetch).toHaveBeenCalledTimes(1);
      const sentInit = baseFetch.mock.calls[0][1] as RequestInit;
      expect(sentInit.body).toBe(body);
    } finally {
      handle.uninstall();
      restore();
    }
  });

  it('scrubs a Uint8Array body byte-for-byte', async () => {
    const handle = install([{ name: 'TOKEN', value: 'tok-real-abc', domains: ['*'] }]);
    try {
      const raw = new TextEncoder().encode('payload tok-real-abc end');
      await globalThis.fetch('https://api.example.com/v1', { method: 'POST', body: raw });
      const sentInit = baseFetch.mock.calls[0][1] as RequestInit;
      const sentBody = sentInit.body as Uint8Array;
      const decoded = new TextDecoder().decode(sentBody);
      expect(decoded).not.toContain('tok-real-abc');
      expect(decoded).toMatch(/^payload [a-f0-9]{12} end$/);
    } finally {
      handle.uninstall();
      restore();
    }
  });

  it('scrubs the body of a Request input and keeps the URL', async () => {
    const handle = install([{ name: 'TOKEN', value: 'tok-real-abc', domains: ['*'] }]);
    try {
      const req = new Request('https://api.example.com/v1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: 'tok-real-abc' }),
      });
      await globalThis.fetch(req);
      expect(baseFetch).toHaveBeenCalledTimes(1);
      const sentReq = baseFetch.mock.calls[0][0] as Request;
      expect(sentReq).toBeInstanceOf(Request);
      expect(sentReq.url).toBe('https://api.example.com/v1');
      const text = await sentReq.text();
      expect(text).not.toContain('tok-real-abc');
      expect(text).toMatch(/"x":"[a-f0-9]{12}"/);
    } finally {
      handle.uninstall();
      restore();
    }
  });

  it('does not buffer or break a streaming response body (SSE-style)', async () => {
    // SW returns a streaming ReadableStream — the wrapper must not read it.
    const chunks = ['data: hello\n\n', 'data: world\n\n'];
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    baseFetch.mockImplementationOnce(
      async () =>
        new Response(upstream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
    );
    const handle = install([{ name: 'TOKEN', value: 'tok-real-abc', domains: ['*'] }]);
    try {
      const resp = await globalThis.fetch('https://api.example.com/sse', { method: 'POST' });
      // Response body must still be a live ReadableStream — proves we did
      // not call .text() / .arrayBuffer() on it.
      expect(resp.body).not.toBeNull();
      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let acc = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += dec.decode(value);
      }
      expect(acc).toBe(chunks.join(''));
    } finally {
      handle.uninstall();
      restore();
    }
  });

  it('uninstall restores the original fetch', async () => {
    const handle = install([{ name: 'TOKEN', value: 'tok', domains: ['*'] }]);
    const wrapped = globalThis.fetch;
    handle.uninstall();
    expect(globalThis.fetch).not.toBe(wrapped);
    restore();
  });
});
