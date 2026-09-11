import { describe, expect, it, vi } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';
import previewWorker from '../src/preview-worker.js';
import { makeEnv } from './helpers/fake-env.js';

const previewOrigin =
  'https://0123456789abcdef0123456789abcdef--0123456789abcdef0123456789abcdef01234567.sliccy.now';
const internalMutationPaths = [
  '/internal/preview/import',
  '/internal/preview/relocate',
  '/internal/preview/activate',
  '/internal/preview/revoke-forwarded',
  '/internal/preview/transfer',
  '/internal/preview/upload-release',
  '/internal/home/bind',
  '/internal/home/deliver',
  '/internal/home/revoke',
  '/internal/home/rotate',
  '/internal/home/revoke-registration',
  '/internal/confirm-controller-ownership',
];

describe.each([
  { name: 'hub public origin', origin: 'https://www.sliccy.ai', fetch: handleWorkerRequest },
  { name: 'hub preview origin', origin: previewOrigin, fetch: handleWorkerRequest },
  { name: 'dedicated preview worker', origin: previewOrigin, fetch: previewWorker.fetch },
])('$name internal route isolation', ({ origin, fetch: publicFetch }) => {
  it.each(internalMutationPaths)('blocks public POST %s mutations', async (path) => {
    // A valid live preview exercises the full preview path, not an early
    // invalid-token 404. Resolving/reading a preview is allowed; importing or
    // changing ownership through a public URL is not.
    const stubFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === '/internal/preview/resolve') {
        return Response.json({
          servedRoot: '/workspace/site',
          entryPath: '/workspace/site/index.html',
          allowLive: true,
          bridge: false,
          mode: 'live',
        });
      }
      return new Response('ordinary preview content', {
        headers: { 'content-type': 'text/plain' },
      });
    });
    const env = makeEnv();
    // Watch every namespace reachable by the public routers. A success or 404
    // alone would miss an accidental forwarding side effect.
    vi.spyOn(env.TRAY_HUB, 'get').mockReturnValue({ fetch: stubFetch });
    vi.spyOn(env.WEBHOOK_HOMES, 'get').mockReturnValue({ fetch: stubFetch });
    vi.spyOn(env.CLOUD_SESSIONS, 'get').mockReturnValue({ fetch: stubFetch });

    await publicFetch(
      new Request(`${origin}${path}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer source.controller',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          controllerToken: 'source.controller',
          targetTrayId: 'target',
          targetControllerToken: 'target.controller',
          transferToken: 'transfer.secret',
        }),
      }),
      env
    );

    const dispatchedPaths = stubFetch.mock.calls.map(([request]) => new URL(request.url).pathname);
    expect(
      dispatchedPaths.filter((dispatched) => internalMutationPaths.includes(dispatched))
    ).toEqual([]);
    if (origin === previewOrigin) {
      expect(dispatchedPaths).toEqual(['/internal/preview/resolve', '/internal/preview/fetch']);
    } else {
      expect(dispatchedPaths).toEqual([]);
    }
  });
});
