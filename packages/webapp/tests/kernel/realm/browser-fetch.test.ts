/**
 * Tests for `browser.fetch(tab, url, opts)`. Verifies the
 * page-context script the bridge injects via `evalAsync` is a single
 * self-contained function (no temp-file, no base64 chunking, no
 * realm-side closures) and that the response shape matches the spec.
 *
 * The realm-side bridge calls `browser.evalAsync(targetId, script)`
 * under the hood. Tests capture the injected script via a custom
 * mock `evaluate`, returning a synthetic structured response so the
 * round-trip through `unwrapEvalResult` is exercised end-to-end.
 */

import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { describe, expect, it } from 'vitest';
import type { BrowserAPI } from '../../../src/cdp/browser-api.js';
import {
  type BrowserFetchResult,
  buildBrowserFetchScript,
} from '../../../src/kernel/realm/js-realm-shared.js';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import { type RealmPortLike, RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';

describe('buildBrowserFetchScript — page-context script shape', () => {
  it('emits a single self-calling async IIFE (no temp-file VFS dance)', async () => {
    const script = await buildBrowserFetchScript('/api/x');
    expect(script.startsWith('(async () => {')).toBe(true);
    expect(script.endsWith('})()')).toBe(true);
    expect(script).toContain('await fetch(');
    // Defensive: the dance the spec calls out as fragile (temp-file
    // write via the VFS) must not appear in the injected page script.
    // `btoa`/`atob`/base64 ARE now expected (binary response encoding +
    // binary request reconstruction), so only `writeFile`/`fs.` are
    // forbidden — a regression to the old temp-file shape.
    expect(script).not.toMatch(/writeFile|fs\./);
    // Single function — no semicolons separating top-level
    // statements outside the IIFE.
    expect(script.match(/^\(async \(\) => \{/g)?.length).toBe(1);
  });

  it('defaults credentials to "include" so session cookies travel', async () => {
    const script = await buildBrowserFetchScript('/api/x');
    expect(script).toContain('"credentials":"include"');
  });

  it('honors explicit credentials override (same-origin / omit)', async () => {
    expect(await buildBrowserFetchScript('/x', { credentials: 'same-origin' })).toContain(
      '"credentials":"same-origin"'
    );
    expect(await buildBrowserFetchScript('/x', { credentials: 'omit' })).toContain(
      '"credentials":"omit"'
    );
  });

  it('serializes a plain-object body as JSON and sets Content-Type', async () => {
    const script = await buildBrowserFetchScript('/api/conversations.list', {
      method: 'POST',
      body: { channel: 'C123' },
    });
    expect(script).toContain('"method":"POST"');
    expect(script).toContain('"Content-Type":"application/json"');
    expect(script).toContain('"body":"{\\"channel\\":\\"C123\\"}"');
  });

  it('preserves caller-provided Content-Type for non-object bodies', async () => {
    const script = await buildBrowserFetchScript('/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=2',
    });
    // String body passes through verbatim, no auto Content-Type.
    expect(script).toContain('"body":"a=1&b=2"');
    expect(script).toContain('"content-type":"application/x-www-form-urlencoded"');
    expect(script).not.toContain('"Content-Type":"application/json"');
  });

  it('preserves custom request headers in both directions', async () => {
    const script = await buildBrowserFetchScript('/api/x', {
      headers: { Authorization: 'Bearer abc', 'X-Custom': 'v' },
    });
    expect(script).toContain('"Authorization":"Bearer abc"');
    expect(script).toContain('"X-Custom":"v"');
  });

  it('safely escapes adversarial url + body content via JSON encoding', async () => {
    // Defends against a malicious url breaking out of the injected
    // string. JSON.stringify is the only escape boundary.
    const url = '"</script><script>alert(1)</script>';
    const script = await buildBrowserFetchScript(url, { body: { x: '"); alert(1); //' } });
    // Both must round-trip through JSON.parse(<extracted>) cleanly.
    const urlMatch = /await fetch\((".*?"),/.exec(script);
    expect(urlMatch).not.toBeNull();
    expect(JSON.parse(urlMatch![1])).toBe(url);
  });

  it('returns parsed JSON / text / headers via the page-side script', async () => {
    // Execute the script in-process: it only references `fetch` and
    // a Response-like surface, so a thin stub is enough to drive
    // the entire response-assembly branch without a real browser.
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: new Map<string, string>([['content-type', 'application/json']]),
    };
    const headersStub = {
      forEach: (cb: (v: string, k: string) => void) => {
        for (const [k, v] of fakeResponse.headers) cb(v, k);
      },
      get: (k: string) => fakeResponse.headers.get(k.toLowerCase()) ?? null,
    };
    const captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = async (u: string, init: RequestInit) => {
      captured.url = u;
      captured.init = init;
      return {
        ok: fakeResponse.ok,
        status: fakeResponse.status,
        headers: headersStub,
        json: async () => ({ hello: 'world' }),
        text: async () => '{"hello":"world"}',
      };
    };
    const script = await buildBrowserFetchScript('/api/x', {
      method: 'POST',
      body: { channel: 'C1' },
    });
    const result = (await new Function('fetch', `return ${script};`)(
      fakeFetch
    )) as BrowserFetchResult;
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ 'content-type': 'application/json' });
    expect(result.body).toEqual({ hello: 'world' });
    expect(captured.url).toBe('/api/x');
    expect(captured.init?.method).toBe('POST');
    expect((captured.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );
    expect(captured.init?.credentials).toBe('include');
    expect(captured.init?.body).toBe('{"channel":"C1"}');
  });

  it('falls back to text when content-type is not JSON', async () => {
    const headersStub = {
      forEach: (cb: (v: string, k: string) => void) => cb('text/html', 'content-type'),
      get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/html' : null),
    };
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      headers: headersStub,
      text: async () => '<html></html>',
      json: async () => {
        throw new Error('should not be called');
      },
    });
    const script = await buildBrowserFetchScript('/page');
    const result = (await new Function('fetch', `return ${script};`)(
      fakeFetch
    )) as BrowserFetchResult;
    expect(result.body).toBe('<html></html>');
  });

  it('does not double-read the body on an empty JSON response (repro #1442)', async () => {
    // Drive the built script against a REAL `Response` so the
    // single-consumption stream semantics are exercised faithfully.
    // An empty-STRING body has a real (empty) stream — the pre-fix
    // branch did `await r.json()` (consumes the stream, throws on empty
    // JSON) then `await r.text()` in the catch, a second read that
    // throws "body stream already read".
    const fakeFetch = async () =>
      new Response('', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const script = await buildBrowserFetchScript('/api/empty');
    const result = (await new Function('fetch', `return ${script};`)(
      fakeFetch
    )) as BrowserFetchResult;
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toBeNull();
  });

  it('returns body null for a 204/empty-body PATCH/DELETE without throwing', async () => {
    const fakeFetch = async () =>
      new Response(null, {
        status: 204,
        headers: { 'content-type': 'application/json' },
      });
    const script = await buildBrowserFetchScript('/api/thing', { method: 'DELETE' });
    const result = (await new Function('fetch', `return ${script};`)(
      fakeFetch
    )) as BrowserFetchResult;
    expect(result.status).toBe(204);
    expect(result.body).toBeNull();
  });

  it('parses a real non-empty JSON Response body exactly once', async () => {
    const fakeFetch = async () =>
      new Response('{"hello":"world"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const script = await buildBrowserFetchScript('/api/x');
    const result = (await new Function('fetch', `return ${script};`)(
      fakeFetch
    )) as BrowserFetchResult;
    expect(result.body).toEqual({ hello: 'world' });
  });

  // ---- Request-body round-trips (bridge → page reconstruction) ----

  it('serializes URLSearchParams as a form-urlencoded body with default Content-Type', async () => {
    const script = await buildBrowserFetchScript('/api/x', {
      method: 'POST',
      body: new URLSearchParams({ a: '1', b: 'two words' }),
    });
    expect(script).toContain('"body":"a=1&b=two+words"');
    expect(script).toContain('"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"');
  });

  it('round-trips a binary request body (Uint8Array) through base64 reconstruction', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    const captured: { body?: unknown } = {};
    const fakeFetch = async (_u: string, init: RequestInit) => {
      captured.body = init.body;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const script = await buildBrowserFetchScript('/upload', {
      method: 'POST',
      body: bytes,
    });
    // Descriptor path emits atob-based reconstruction in the page.
    expect(script).toContain('atob(');
    await new Function('fetch', `return ${script};`)(fakeFetch);
    expect(captured.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(captured.body as Uint8Array)).toEqual(Array.from(bytes));
  });

  it('round-trips a multipart FormData body (string field + file part)', async () => {
    const form = new FormData();
    form.append('field', 'value');
    form.append(
      'file',
      new Blob([new Uint8Array([9, 8, 7])], { type: 'application/octet-stream' }),
      'f.bin'
    );
    const captured: { body?: unknown } = {};
    const fakeFetch = async (_u: string, init: RequestInit) => {
      captured.body = init.body;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const script = await buildBrowserFetchScript('/multipart', { method: 'POST', body: form });
    await new Function('fetch', `return ${script};`)(fakeFetch);
    expect(captured.body).toBeInstanceOf(FormData);
    const rebuilt = captured.body as FormData;
    expect(rebuilt.get('field')).toBe('value');
    const file = rebuilt.get('file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('f.bin');
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([9, 8, 7]);
  });

  // ---- Binary response detection + base64 return ----

  it('returns a base64 body with bodyEncoding for responseType:"binary"', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 250, 255]);
    const fakeFetch = async () =>
      new Response(bytes, { status: 200, headers: { 'content-type': 'application/json' } });
    const script = await buildBrowserFetchScript('/blob', { responseType: 'binary' });
    const result = (await new Function('fetch', `return ${script};`)(
      fakeFetch
    )) as BrowserFetchResult;
    expect(result.bodyEncoding).toBe('base64');
    // Decode and confirm no corruption round-trips through base64.
    const decoded = Uint8Array.from(atob(result.body as string), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('auto-detects a binary Content-Type (image/png) and returns base64', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const fakeFetch = async () =>
      new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
    const script = await buildBrowserFetchScript('/img');
    const result = (await new Function('fetch', `return ${script};`)(
      fakeFetch
    )) as BrowserFetchResult;
    expect(result.bodyEncoding).toBe('base64');
    const decoded = Uint8Array.from(atob(result.body as string), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('does NOT treat text/* as binary (no base64 encoding)', async () => {
    const fakeFetch = async () =>
      new Response('plain text', { status: 200, headers: { 'content-type': 'text/plain' } });
    const script = await buildBrowserFetchScript('/txt');
    const result = (await new Function('fetch', `return ${script};`)(
      fakeFetch
    )) as BrowserFetchResult;
    expect(result.bodyEncoding).toBeUndefined();
    expect(result.body).toBe('plain text');
  });

  it('responseType:"text" forces raw text even for an application/json response', async () => {
    const fakeFetch = async () =>
      new Response('{"hello":"world"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const script = await buildBrowserFetchScript('/api/x', { responseType: 'text' });
    const result = (await new Function('fetch', `return ${script};`)(
      fakeFetch
    )) as BrowserFetchResult;
    expect(result.bodyEncoding).toBeUndefined();
    expect(result.body).toBe('{"hello":"world"}');
  });

  it('responseType:"json" parses even when the Content-Type is not JSON', async () => {
    const fakeFetch = async () =>
      new Response('{"n":42}', { status: 200, headers: { 'content-type': 'text/plain' } });
    const script = await buildBrowserFetchScript('/api/x', { responseType: 'json' });
    const result = (await new Function('fetch', `return ${script};`)(
      fakeFetch
    )) as BrowserFetchResult;
    expect(result.body).toEqual({ n: 42 });
  });
});

// ---------------------------------------------------------------------------
// Integration: realm-side bridge → RPC → host → mock browser.evaluate
// ---------------------------------------------------------------------------

interface PortPair {
  realm: RealmPortLike;
  host: RealmPortLike;
}

function makePortPair(): PortPair {
  const realmListeners = new Set<(event: MessageEvent) => void>();
  const hostListeners = new Set<(event: MessageEvent) => void>();
  const realm: RealmPortLike = {
    postMessage: (msg) => {
      for (const h of [...hostListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_t, h) => {
      realmListeners.add(h);
    },
    removeEventListener: (_t, h) => {
      realmListeners.delete(h);
    },
  };
  const host: RealmPortLike = {
    postMessage: (msg) => {
      for (const h of [...realmListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_t, h) => {
      hostListeners.add(h);
    },
    removeEventListener: (_t, h) => {
      hostListeners.delete(h);
    },
  };
  return { realm, host };
}

function makeNoopFs(): IFileSystem {
  const stub = async (): Promise<never> => {
    throw new Error('not implemented');
  };
  return {
    readFile: stub,
    readFileBuffer: stub,
    writeFile: stub,
    appendFile: stub,
    exists: async () => false,
    stat: stub as unknown as (p: string) => Promise<FsStat>,
    mkdir: stub,
    readdir: async () => [],
    rm: stub,
    cp: stub,
    mv: stub,
    resolvePath: (base: string, p: string) => (p.startsWith('/') ? p : `${base}/${p}`),
    getAllPaths: () => [],
    chmod: stub,
    symlink: stub,
    link: stub,
    readlink: stub,
    lstat: stub as unknown as (p: string) => Promise<FsStat>,
    realpath: async (p: string) => p,
    utimes: stub,
  } as unknown as IFileSystem;
}

describe('realm RPC: browser.fetch — round-trip through evalAsync', () => {
  it('captures the injected script and returns the structured response', async () => {
    const captured: string[] = [];
    const cannedResponse: BrowserFetchResult = {
      ok: true,
      status: 201,
      headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
      body: { ok: true, channel: 'C123' },
    };
    const browser = {
      async withTab<T>(_targetId: string, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
      async evaluate(expression: string): Promise<unknown> {
        captured.push(expression);
        // Return the structured-clone shape browser.fetch promises;
        // unwrapEvalResult passes objects through untouched.
        return cannedResponse;
      },
    } as unknown as BrowserAPI;

    const ctx = {
      fs: makeNoopFs(),
      cwd: '/workspace',
      env: new Map(),
      stdin: '',
    } as unknown as CommandContext;
    const { realm, host } = makePortPair();
    const handle = attachRealmHost(host, ctx, { browser });
    const client = new RealmRpcClient(realm);
    try {
      // Mirror what `browserBridge.fetch` does internally: build the
      // page-context script and dispatch through evalAsync.
      const script = await buildBrowserFetchScript('/api/post', {
        method: 'POST',
        body: { channel: 'C123' },
      });
      const result = await client.call<BrowserFetchResult>('browser', 'evalAsync', ['t1', script]);
      expect(result).toEqual(cannedResponse);
      expect(captured).toHaveLength(1);
      // The script the host evaluated must be exactly the one we built —
      // no realm-side mutation, no JSON.parse(JSON.parse(...)) ceremony.
      expect(captured[0]).toBe(script);
      expect(captured[0]).toContain('await fetch(');
      expect(captured[0]).toContain('"credentials":"include"');
    } finally {
      client.dispose();
      handle.dispose();
    }
  });
});

describe('sandbox.html ↔ js-realm-shared parity — browser.fetch', () => {
  it('both surfaces wire browser.fetch through evalAsync', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..', '..', '..', '..', '..');
    const [sandbox, shared] = await Promise.all([
      readFile(path.join(repoRoot, 'packages/chrome-extension/sandbox.html'), 'utf8'),
      readFile(path.join(repoRoot, 'packages/webapp/src/kernel/realm/js-realm-shared.ts'), 'utf8'),
    ]);
    // Both must expose `fetch:` on the bridge, both must build the
    // page-context script via a `buildBrowserFetchScript` helper, and
    // both must dispatch through the `evalAsync` RPC op (no new
    // browser channel verb introduced).
    expect(shared).toMatch(/fetch:\s*\(\s*tab/);
    expect(sandbox).toMatch(/fetch:\s*\(tab/);
    expect(shared).toMatch(/buildBrowserFetchScript\s*\(/);
    expect(sandbox).toMatch(/buildBrowserFetchScript\s*\(/);
    // Default credentials: 'include' is the cross-cutting guarantee.
    expect(shared).toContain("'include'");
    expect(sandbox).toContain("'include'");
  });
});
