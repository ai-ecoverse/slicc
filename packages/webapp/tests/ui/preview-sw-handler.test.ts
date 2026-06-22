/**
 * Tests for the pure `/preview/*` request handler extracted from
 * `preview-sw.ts`. The point of these tests is the regression that
 * motivated the extraction: after OPFS migration the SW used to read
 * the legacy IDB-backed VFS first and serve stale bytes. The handler
 * must now route every read through the responder channel and always
 * return whatever the responder says is current.
 *
 * Pins:
 *  - A write that lands in the responder between two requests is
 *    visible on the second request (no SW-side caching).
 *  - ENOENT from the responder → 404 (silent).
 *  - EISDIR from the responder → retry once with `/index.html`.
 *  - Other errors → 500 with the error text.
 *  - Responder timeout → 404 (treated as "not found", not 5xx).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  getMimeType,
  handlePreviewRequest,
  isSliccAppPath,
  type PreviewChannel,
} from '../../src/ui/preview-sw-handler.js';

type ResponderReply =
  | { content: string | Uint8Array }
  | { error: string }
  | { drop: true } /* never reply — to exercise the timeout branch */;

/**
 * In-memory `BroadcastChannel` stand-in plus a programmable responder
 * that mimics `installPreviewVfsResponder`'s wire shape.
 */
class FakeChannel implements PreviewChannel {
  private listeners = new Set<(ev: MessageEvent) => void>();
  reads: Array<{ path: string; asText: boolean }> = [];
  reply: (path: string) => ResponderReply = () => ({ error: 'ENOENT: no such file' });

  postMessage(data: unknown): void {
    const msg = data as { type?: string; id?: string; path?: string; asText?: boolean } | undefined;
    if (msg?.type !== 'preview-vfs-read' || !msg.id || !msg.path) return;
    this.reads.push({ path: msg.path, asText: !!msg.asText });
    const out = this.reply(msg.path);
    if ('drop' in out) return;
    queueMicrotask(() => {
      const env = { type: 'preview-vfs-response', id: msg.id, ...out };
      for (const l of this.listeners) l({ data: env } as MessageEvent);
    });
  }
  addEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.delete(l);
  }
}

describe('getMimeType', () => {
  it('maps common extensions and falls back to octet-stream', () => {
    expect(getMimeType('/a/b.html')).toBe('text/html');
    expect(getMimeType('/a/b.css')).toBe('text/css');
    expect(getMimeType('/a/b.png')).toBe('image/png');
    expect(getMimeType('/a/b.unknownext')).toBe('application/octet-stream');
  });
});

describe('isSliccAppPath', () => {
  it('excludes slicc app paths from project-serve interception', () => {
    expect(isSliccAppPath('/api/fetch-proxy')).toBe(true);
    expect(isSliccAppPath('/@vite/client')).toBe(true);
    expect(isSliccAppPath('/node_modules/foo/x.js')).toBe(true);
    expect(isSliccAppPath('/')).toBe(true);
    expect(isSliccAppPath('/styles/main.css')).toBe(false);
  });
});

describe('handlePreviewRequest', () => {
  it('serves the current responder bytes on every request (no stale-read cache)', async () => {
    const ch = new FakeChannel();
    let bytes = 'first';
    ch.reply = () => ({ content: bytes });

    const r1 = await handlePreviewRequest(ch, '/shared/post.html');
    expect(r1.status).toBe(200);
    expect(r1.headers.get('Content-Type')).toBe('text/html');
    expect(await r1.text()).toBe('first');

    // Mutate the responder-backed VFS between requests. A cached SW
    // would still return 'first'; the handler must reflect 'second'.
    bytes = 'second';
    const r2 = await handlePreviewRequest(ch, '/shared/post.html');
    expect(r2.status).toBe(200);
    expect(await r2.text()).toBe('second');

    expect(ch.reads).toHaveLength(2);
    expect(ch.reads.every((r) => r.path === '/shared/post.html')).toBe(true);
    expect(ch.reads.every((r) => r.asText === true)).toBe(true);
  });

  it('requests binary for non-text mime types', async () => {
    const ch = new FakeChannel();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    ch.reply = () => ({ content: png });

    const r = await handlePreviewRequest(ch, '/shared/logo.png');
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('image/png');
    const buf = new Uint8Array(await r.arrayBuffer());
    expect(Array.from(buf)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(ch.reads[0]?.asText).toBe(false);
  });

  it('returns 404 on ENOENT with a distinguishing body', async () => {
    const ch = new FakeChannel();
    ch.reply = () => ({ error: 'ENOENT: missing /x.html' });
    const r = await handlePreviewRequest(ch, '/x.html');
    expect(r.status).toBe(404);
    const body = await r.text();
    expect(body).toContain('ENOENT');
    expect(body).toContain('/x.html');
    expect(body).not.toContain('responder timeout');
  });

  it('retries with /index.html on EISDIR', async () => {
    const ch = new FakeChannel();
    ch.reply = (path) =>
      path === '/site/index.html'
        ? { content: '<h1>idx</h1>' }
        : { error: 'EISDIR: is a directory' };
    const r = await handlePreviewRequest(ch, '/site');
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('text/html');
    expect(await r.text()).toBe('<h1>idx</h1>');
    expect(ch.reads.map((x) => x.path)).toEqual(['/site', '/site/index.html']);
  });

  it('returns 500 on other responder errors', async () => {
    const ch = new FakeChannel();
    ch.reply = () => ({ error: 'EACCES: permission denied' });
    const r = await handlePreviewRequest(ch, '/locked.html');
    expect(r.status).toBe(500);
    expect(await r.text()).toContain('EACCES');
  });

  it('returns 404 when the responder never replies, labeled as responder timeout', async () => {
    const ch = new FakeChannel();
    ch.reply = () => ({ drop: true });
    const r = await handlePreviewRequest(ch, '/never.html', 25);
    expect(r.status).toBe(404);
    const body = await r.text();
    expect(body).toContain('responder timeout');
    expect(body).toContain('/never.html');
    expect(body).not.toContain('ENOENT');
  });

  it('recovers via re-post when the responder is not listening on the first read', async () => {
    // Cold-start race: a freshly-committed `/preview/*` page's responder is
    // not yet wired into the BroadcastChannel when the SW posts the first
    // sub-resource read, so that message is dropped. A re-post must land once
    // the responder attaches instead of the read stalling for the full window.
    const ch = new FakeChannel();
    let live = false;
    ch.reply = () => (live ? { content: 'late' } : { drop: true });

    vi.useFakeTimers();
    try {
      const pending = handlePreviewRequest(ch, '/cold.html');
      // First post is dropped (responder not attached yet).
      await vi.advanceTimersByTimeAsync(150);
      // Responder attaches; the next re-post (200 ms cadence) is answered.
      live = true;
      await vi.advanceTimersByTimeAsync(100);
      const r = await pending;
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('late');
      expect(ch.reads.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-issue a slow read once the responder acks', async () => {
    // The ack halts the cold-start re-post loop before the (slow, possibly
    // multi-MB) read settles, so a healthy responder is never asked twice.
    const ch = new FakeChannel();
    const listeners = (ch as unknown as { listeners: Set<(ev: MessageEvent) => void> }).listeners;
    let reads = 0;
    ch.postMessage = (data: unknown): void => {
      const msg = data as { type?: string; id?: string; path?: string } | undefined;
      if (msg?.type !== 'preview-vfs-read' || !msg.id) return;
      reads++;
      queueMicrotask(() => {
        const ack = { type: 'preview-vfs-ack', id: msg.id };
        for (const l of listeners) l({ data: ack } as MessageEvent);
      });
      setTimeout(() => {
        const env = { type: 'preview-vfs-response', id: msg.id, content: 'slow' };
        for (const l of listeners) l({ data: env } as MessageEvent);
      }, 5000);
    };

    vi.useFakeTimers();
    try {
      const pending = handlePreviewRequest(ch, '/big.txt');
      await vi.advanceTimersByTimeAsync(5000);
      const r = await pending;
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('slow');
      expect(reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes a slow read that arrives after the legacy 5 s cap but inside the new 30 s window', async () => {
    // Regression guard for Wave 13c R2: large binary reads (pyodide.asm.wasm,
    // python_stdlib.zip, Whisper ONNX weights) used to time out at the old
    // 5 s SW cap while the underlying VFS RPC still had ~25 s of headroom.
    // Replace the FakeChannel's synchronous reply with a 6 s delayed reply.
    const ch = new FakeChannel();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const listeners = (ch as unknown as { listeners: Set<(ev: MessageEvent) => void> }).listeners;
    ch.postMessage = (data: unknown): void => {
      const msg = data as
        | { type?: string; id?: string; path?: string; asText?: boolean }
        | undefined;
      if (msg?.type !== 'preview-vfs-read' || !msg.id || !msg.path) return;
      ch.reads.push({ path: msg.path, asText: !!msg.asText });
      setTimeout(() => {
        const env = { type: 'preview-vfs-response', id: msg.id, content: png };
        for (const l of listeners) l({ data: env } as MessageEvent);
      }, 6000);
    };
    vi.useFakeTimers();
    try {
      const pending = handlePreviewRequest(ch, '/workspace/pyodide.asm.wasm');
      await vi.advanceTimersByTimeAsync(6000);
      const r = await pending;
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('application/wasm');
      const buf = new Uint8Array(await r.arrayBuffer());
      expect(Array.from(buf)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      vi.useRealTimers();
    }
  });
});
