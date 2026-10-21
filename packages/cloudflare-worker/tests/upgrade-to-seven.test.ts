import { describe, expect, it } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';
import { UPGRADE_TO_SEVEN_PATH } from '../src/upgrade-to-seven.js';
import { makeEnv } from './helpers/fake-env.js';

const EXPORTER_HTML = '<!doctype html><title>Moving SLICC 6 to seven</title>';
const SPA_HTML = '<!doctype html><title>slicc</title>';

function assets(seen: string[] = []) {
  return {
    fetch: async (req: Request) => {
      const { pathname } = new URL(req.url);
      seen.push(pathname);
      if (pathname === UPGRADE_TO_SEVEN_PATH) {
        return new Response(null, { status: 307, headers: { location: '/upgrade-to-seven' } });
      }
      const html = pathname === '/upgrade-to-seven' ? EXPORTER_HTML : SPA_HTML;
      return new Response(html, {
        headers: {
          'content-type': 'text/html',
          'Document-Isolation-Policy': 'isolate-and-credentialless',
        },
      });
    },
  };
}

describe('GET /upgrade-to-seven.html', () => {
  it('serves the exporter page, framable by its own origin only', async () => {
    const seen: string[] = [];
    const res = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai${UPGRADE_TO_SEVEN_PATH}`),
      makeEnv({ ASSETS: assets(seen) })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EXPORTER_HTML);
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('document-isolation-policy')).toBeNull();

    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(seen).toEqual([UPGRADE_TO_SEVEN_PATH, '/upgrade-to-seven']);
  });

  it('answers HEAD without a body', async () => {
    const res = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai${UPGRADE_TO_SEVEN_PATH}`, { method: 'HEAD' }),
      makeEnv({ ASSETS: assets() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
  });

  it('refuses writes', async () => {
    const res = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai${UPGRADE_TO_SEVEN_PATH}`, { method: 'POST' }),
      makeEnv({ ASSETS: assets() })
    );
    expect(res.status).toBe(405);
  });

  it('leaves six app pages unframable', async () => {
    const res = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/'),
      makeEnv({ ASSETS: assets() })
    );
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });
});
