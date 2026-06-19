import { describe, expect, it } from 'vitest';
import { buildLeaderConnectSrc, handleWorkerRequest, type WorkerEnv } from '../src/index.js';

const CLOUD_HTML = '<!doctype html><html><body>cloud dashboard</body></html>';

const fakeAssets = {
  fetch: async (_req: Request) =>
    new Response(CLOUD_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
};

const fakeCloudSessions = {
  idFromName: (_name: string) => ({ toString: () => 'fake-cloud-id' }),
  idFromString: (_id: string) => ({ toString: () => 'fake-cloud-id' }),
  newUniqueId: () => ({ toString: () => 'fake-cloud-id' }),
  get: (_id: unknown) => ({
    fetch: async (_req: Request) => new Response('cloud DO not stubbed', { status: 501 }),
  }),
};

const fakeTrayHub = {
  idFromName: (_name: string) => ({ toString: () => 'fake-tray-id' }),
  idFromString: (_id: string) => ({ toString: () => 'fake-tray-id' }),
  newUniqueId: () => ({ toString: () => 'fake-tray-id' }),
  get: (_id: unknown) => ({
    fetch: async (_req: Request) => new Response('tray DO not stubbed', { status: 501 }),
  }),
};

function makeEnv(): WorkerEnv {
  return {
    TRAY_HUB: fakeTrayHub,
    CLOUD_SESSIONS: fakeCloudSessions,
    ASSETS: fakeAssets,
  } as unknown as WorkerEnv;
}

describe('CSP on /cloud responses', () => {
  it('serves /cloud with a content-security-policy header', async () => {
    const res = await handleWorkerRequest(new Request('https://w.test/cloud'), makeEnv());
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('https://ims-na1.adobelogin.com');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('serves /cloud/some-asset with the same CSP', async () => {
    const res = await handleWorkerRequest(
      new Request('https://w.test/cloud/assets/main.js'),
      makeEnv()
    );
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
  });

  it('serves /auth/cloud-callback with strict CSP (no IMS connect)', async () => {
    const res = await handleWorkerRequest(
      new Request('https://w.test/auth/cloud-callback'),
      makeEnv()
    );
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('connect-src on /cloud permits the Adobe proxy, both IMS hosts, and local bridge WebSockets', async () => {
    const res = await handleWorkerRequest(new Request('https://w.test/cloud'), makeEnv());
    const csp = res.headers.get('content-security-policy') ?? '';
    const connectSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('connect-src '));
    expect(connectSrc).toBeTruthy();
    // Adobe LLM proxy (default origin) must be reachable.
    expect(connectSrc).toContain('https://adobe-llm-proxy.paolo-moz.workers.dev');
    // Both IMS hosts (prod + stg1).
    expect(connectSrc).toContain('https://ims-na1.adobelogin.com');
    expect(connectSrc).toContain('https://ims-na1-stg1.adobelogin.com');
    // Local bridge WebSocket: dynamic port on either loopback name.
    expect(connectSrc).toContain('ws://localhost:*');
    expect(connectSrc).toContain('ws://127.0.0.1:*');
    // Same-origin still allowed.
    expect(connectSrc).toContain("'self'");
    // No bare wildcard — the directive must stay an explicit allowlist.
    const tokens = (connectSrc as string).slice('connect-src '.length).split(/\s+/).filter(Boolean);
    expect(tokens).not.toContain('*');
  });

  it('buildLeaderConnectSrc honours ADOBE_PROXY_ENDPOINT and strips path/trailing slash', () => {
    const directive = buildLeaderConnectSrc({
      ADOBE_PROXY_ENDPOINT: 'https://custom-proxy.example.com/v1/',
    });
    const tokens = directive.split(/\s+/).filter(Boolean);
    // Only the origin is emitted — paths and trailing slashes must be stripped.
    expect(tokens).toContain('https://custom-proxy.example.com');
    expect(tokens).not.toContain('https://custom-proxy.example.com/');
    expect(tokens).not.toContain('https://custom-proxy.example.com/v1/');
    // No bare wildcard.
    expect(tokens).not.toContain('*');
    // Required sources still present.
    expect(tokens).toContain("'self'");
    expect(tokens).toContain('https://ims-na1.adobelogin.com');
    expect(tokens).toContain('https://ims-na1-stg1.adobelogin.com');
    expect(tokens).toContain('ws://localhost:*');
    expect(tokens).toContain('ws://127.0.0.1:*');
  });

  it('buildLeaderConnectSrc falls back to default proxy when env unset', () => {
    const directive = buildLeaderConnectSrc({});
    expect(directive).toContain('https://adobe-llm-proxy.paolo-moz.workers.dev');
    expect(directive.split(/\s+/).filter(Boolean)).not.toContain('*');
  });
});
