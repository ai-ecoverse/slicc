import { describe, expect, it } from 'vitest';
import { handleWorkerRequest, type WorkerEnv } from '../src/index.js';

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
});
