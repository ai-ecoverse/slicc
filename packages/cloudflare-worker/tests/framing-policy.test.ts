import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDefaultFramingPolicy } from '../src/framing-policy.js';
import worker, { type WorkerEnv } from '../src/index.js';
import { makeEnv } from './helpers/fake-env.js';

const ORIGIN = 'https://www.sliccy.ai';
const DENY = "frame-ancestors 'none'";
const TOKEN = '11111111-1111-4111-8111-111111111111.abcdef';
const HASHED_ASSET = '/assets/index-abcd1234.js';
const PREVIEW_HOST = `https://${'a'.repeat(32)}--secret.sliccy.now`;

const html = () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });

function hubAnswering(answer: Response | (() => Response) | { status: number }) {
  const stub = { fetch: async () => (typeof answer === 'function' ? answer() : answer) };
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => stub,
  } as unknown as WorkerEnv['TRAY_HUB'];
}

function explodingHub() {
  const fail = () => {
    throw new Error('binding missing');
  };
  return { idFromName: fail, get: fail } as unknown as WorkerEnv['TRAY_HUB'];
}

function envWithAssets(assets: () => Response = html, overrides: Partial<WorkerEnv> = {}) {
  return makeEnv({ ASSETS: { fetch: async () => assets() }, ...overrides });
}

function send(path: string, init?: RequestInit, env: WorkerEnv = envWithAssets()) {
  return worker.fetch(new Request(new URL(path, ORIGIN), init), env);
}

function expectDenied(res: Response) {
  expect(res.headers.get('content-security-policy')).toContain(DENY);
  expect(res.headers.get('x-frame-options')).toBe('DENY');
}

function expectNoFramingPolicy(res: Response) {
  expect(res.headers.get('content-security-policy') ?? '').not.toContain('frame-ancestors');
  expect(res.headers.get('x-frame-options')).toBeNull();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('responses without a framing policy are denied at the entry point', () => {
  const POST = { method: 'POST' };
  const routes: [string, string, RequestInit?][] = [
    ['JSON info route', '/status'],
    ['JSON route, HEAD', '/status', { method: 'HEAD' }],
    ['the routes index', '/?json=true'],
    ['the OAuth relay page', '/auth/callback'],
    ['the OAuth relay page, code hop', '/auth/callback?code=abc'],
    ['the MCP OAuth callback', '/auth/mcp-callback'],
    ['the cloud callback script', '/auth/cloud-callback.js'],
    ['the handoff page', '/handoff?upskill=https://github.com/o/r'],
    ['the privacy redirect', '/privacy'],
    ['the rel docs', '/rel/upskill'],
    ['llms.txt', '/llms.txt'],
    ['the api catalog', '/.well-known/api-catalog'],
    ['the CLI installer', '/install-cli'],
    ['a capability preflight', `/join/${TOKEN}`, { method: 'OPTIONS' }],
    ['a capability call', `/join/${TOKEN}?json=true`, POST],
    ['a webhook delivery', `/webhook/${TOKEN}/hook`, POST],
    ['a 404', '/api/fetch-proxy'],
    ['a 404 from a cloud op', '/api/cloud/nope'],
    ['a 405', '/upgrade-to-seven.html', POST],
    ['a 410', '/session', POST],
    ['a 400', '/join/not-a-token?json=true', POST],
  ];

  it.each(routes)('%s', async (_name, path, init) => {
    expectDenied(await send(path, init));
  });

  it('a hashed asset, GET and HEAD', async () => {
    const assets = () => new Response('code', { headers: { 'content-type': 'text/javascript' } });
    const env = envWithAssets(assets);
    expectDenied(await send(HASHED_ASSET, undefined, env));
    expectDenied(await send(HASHED_ASSET, { method: 'HEAD' }, env));
  });

  it('a redirect, on both exits of the root route', async () => {
    const www = await worker.fetch(new Request(`${ORIGIN}/`), envWithAssets());
    expect(www.status).toBe(301);
    expectDenied(www);

    const apex = await worker.fetch(new Request('https://sliccy.ai/some/page'), envWithAssets());
    expect(apex.status).toBe(301);
    expect(apex.headers.get('location')).toBe(`${ORIGIN}/some/page`);
    expectDenied(apex);
  });

  it('an error the entry point recovers from', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = envWithAssets(html, { TRAY_HUB: explodingHub() });
    const res = await send(`/join/${TOKEN}?json=true`, { method: 'POST' }, env);
    expect(res.status).toBe(503);
    expectDenied(res);
  });

  it('a preview host reaching the hub', async () => {
    const res = await worker.fetch(new Request(`${PREVIEW_HOST}/`), envWithAssets());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectDenied(res);
  });

  it('leaves the status and body of the response alone', async () => {
    const res = await send('/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'slicc-tray-hub' });

    const relay = await send('/auth/callback');
    expect(relay.status).toBe(200);
    expect(await relay.text()).toContain('Redirecting to SLICC');

    const privacy = await send('/privacy');
    expect(privacy.status).toBe(301);
    expect(privacy.headers.get('location')).toBe('https://www.sliccy.com/privacy');
  });

  it('adds X-Frame-Options to pages that already deny with frame-ancestors', async () => {
    for (const path of [
      '/?x=1',
      '/some/route',
      `/join/${TOKEN}`,
      '/cloud',
      '/auth/cloud-callback',
    ]) {
      expectDenied(await send(path));
    }
  });

  it('keeps the rest of an existing CSP when it adds frame-ancestors', async () => {
    const assets = () =>
      new Response('code', {
        headers: {
          'content-type': 'text/javascript',
          'content-security-policy': "default-src 'self'; img-src data:;",
        },
      });
    const res = await send(HASHED_ASSET, undefined, envWithAssets(assets));
    expect(res.headers.get('content-security-policy')).toBe(
      `default-src 'self'; img-src data:; ${DENY}`
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('pages framed on purpose', () => {
  it.each([
    ['an allowlist', 'https://host.example https://b.example'],
    ['a wildcard', '*'],
    ['a wildcard with extension origins', '* chrome-extension://abc'],
  ])('cherry with %s keeps its CSP and gets no X-Frame-Options', async (_name, allowed) => {
    const env = envWithAssets(html, { ALLOWED_CHERRY_HOST_ORIGINS: allowed });
    for (const path of ['/?cherry=1&ui-only=1', `/join/${TOKEN}?cherry=1`]) {
      const res = await send(path, undefined, env);
      expect(res.headers.get('content-security-policy')).toBe(`frame-ancestors ${allowed}`);
      expect(res.headers.get('x-frame-options')).toBeNull();
    }
  });

  it('cherry with no allowed hosts denies with both headers', async () => {
    expectDenied(await send('/?cherry=1'));
  });

  it.each([
    ['GET', '/electron?bridge=ws://localhost:9222/cdp&role=leader', 'GET'],
    ['HEAD', '/electron', 'HEAD'],
    ['a trailing slash', '/electron/', 'GET'],
  ])('the electron overlay stays free of framing policy: %s', async (_name, path, method) => {
    const res = await send(path, { method });
    expectNoFramingPolicy(res);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('link')).toContain('rel="status"');
  });

  it('only the overlay page itself is exempt, not everything on its path', async () => {
    expectDenied(await send('/electron', { method: 'POST' }));
    expectDenied(await send('/electron?json=true'));
    expectDenied(await send('/electron/nested'));
    expect((await send('/electron?cherry=1')).headers.get('content-security-policy')).toBe(DENY);
  });

  it('the seven exporter keeps its same-origin policy', async () => {
    const res = await send('/upgrade-to-seven.html');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('never touches a WebSocket upgrade', async () => {
    // A 101 cannot be built with the Response constructor outside workerd, the
    // same stand-in shape websocketResponse falls back to.
    const upgrade = { status: 101, headers: new Headers(), webSocket: {} };
    const env = envWithAssets(html, { TRAY_HUB: hubAnswering(upgrade) });
    const res = await send(`/controller/${TOKEN}`, { headers: { Upgrade: 'websocket' } }, env);
    expect(res).toBe(upgrade);
    expect(upgrade.headers.get('content-security-policy')).toBeNull();
    expect(upgrade.headers.get('x-frame-options')).toBeNull();
  });
});

describe('withDefaultFramingPolicy', () => {
  const withHeaders = (headers: HeadersInit, status = 200) =>
    new Response(null, { status, headers });

  it('sets both headers on a response with neither', () => {
    const out = withDefaultFramingPolicy(withHeaders({}));
    expect(out.headers.get('content-security-policy')).toBe(DENY);
    expect(out.headers.get('x-frame-options')).toBe('DENY');
  });

  it.each([
    ["default-src 'self'", `default-src 'self'; ${DENY}`],
    ["default-src 'self';", `default-src 'self'; ${DENY}`],
    ["default-src 'self' ; ", `default-src 'self'; ${DENY}`],
    ['   ', DENY],
    ["default-src 'self', img-src data:", `default-src 'self', img-src data:; ${DENY}`],
    // Mentioning the name is not having the directive.
    ['report-uri /csp/frame-ancestors', `report-uri /csp/frame-ancestors; ${DENY}`],
  ])('merges into %j', (csp, merged) => {
    const out = withDefaultFramingPolicy(withHeaders({ 'content-security-policy': csp }));
    expect(out.headers.get('content-security-policy')).toBe(merged);
    expect(out.headers.get('x-frame-options')).toBe('DENY');
  });

  it.each([
    "frame-ancestors 'none'",
    "default-src 'self'; frame-ancestors 'none';",
    "FRAME-ANCESTORS 'NONE'",
    'frame-ancestors',
    "default-src 'self', frame-ancestors 'none'",
  ])('adds X-Frame-Options to the denying policy %j and keeps it as is', (csp) => {
    const out = withDefaultFramingPolicy(withHeaders({ 'content-security-policy': csp }));
    expect(out.headers.get('content-security-policy')).toBe(csp);
    expect(out.headers.get('x-frame-options')).toBe('DENY');
  });

  it.each([
    'frame-ancestors *',
    "frame-ancestors 'self'",
    'frame-ancestors https://a.example',
    "default-src 'self'; Frame-Ancestors https://a.example",
    "frame-ancestors 'none', frame-ancestors https://a.example",
  ])('returns the allowlist policy %j untouched', (csp) => {
    const response = withHeaders({ 'content-security-policy': csp });
    expect(withDefaultFramingPolicy(response)).toBe(response);
    expect(response.headers.get('x-frame-options')).toBeNull();
  });

  it.each(['SAMEORIGIN', 'DENY'])('treats X-Frame-Options: %s as a policy', (value) => {
    const response = withHeaders({ 'x-frame-options': value });
    expect(withDefaultFramingPolicy(response)).toBe(response);
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('x-frame-options')).toBe(value);
  });

  it('works on a response with immutable headers', () => {
    const out = withDefaultFramingPolicy(Response.redirect('https://example.com/', 302));
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('https://example.com/');
    expect(out.headers.get('x-frame-options')).toBe('DENY');
  });

  it('keeps a streaming body', async () => {
    const out = withDefaultFramingPolicy(new Response(new Blob(['stream']).stream()));
    expect(await out.text()).toBe('stream');
  });

  it('keeps null-body statuses', () => {
    expect(withDefaultFramingPolicy(withHeaders({}, 204)).status).toBe(204);
    expect(withDefaultFramingPolicy(withHeaders({}, 304)).status).toBe(304);
  });
});
