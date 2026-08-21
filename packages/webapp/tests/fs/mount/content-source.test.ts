import { describe, expect, it, vi } from 'vitest';
import type { SignedFetchDa, SignedFetchDaRequest } from '../../../src/fs/mount/backend-da.js';
import {
  classifyContentSourceUrl,
  probeContentSource,
} from '../../../src/fs/mount/content-source.js';

function stubFetch(response: Response): {
  signedFetch: SignedFetchDa;
  calls: SignedFetchDaRequest[];
} {
  const calls: SignedFetchDaRequest[] = [];
  const signedFetch = vi.fn(async (req: SignedFetchDaRequest) => {
    calls.push(req);
    return response;
  });
  return { signedFetch, calls };
}

function configResponse(sourceUrl: string | undefined): Response {
  return new Response(
    JSON.stringify({
      content: { source: { type: 'markup', ...(sourceUrl ? { url: sourceUrl } : {}) } },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

describe('classifyContentSourceUrl', () => {
  it('routes an api.aem.live source to the Source Bus', () => {
    expect(classifyContentSourceUrl('https://api.aem.live/adobe/sites/aem-website/source')).toBe(
      'aem'
    );
  });

  it('routes a content.da.live source to DA', () => {
    expect(classifyContentSourceUrl('https://content.da.live/my-org/my-site/')).toBe('da');
  });

  it('falls back to DA for a missing or unparseable url', () => {
    expect(classifyContentSourceUrl(undefined)).toBe('da');
    expect(classifyContentSourceUrl('not a url')).toBe('da');
  });
});

describe('probeContentSource', () => {
  it('reads config.json from the Source Bus origin', async () => {
    const { signedFetch, calls } = stubFetch(
      configResponse('https://api.aem.live/adobe/sites/aem-website/source')
    );
    const probe = await probeContentSource('adobe', 'aem-website', signedFetch);
    expect(probe.backend).toBe('aem');
    expect(probe.sourceUrl).toBe('https://api.aem.live/adobe/sites/aem-website/source');
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/adobe/sites/aem-website/config.json',
      origin: 'https://api.aem.live',
    });
  });

  it('reports DA for a Helix 5 site', async () => {
    const { signedFetch } = stubFetch(configResponse('https://content.da.live/my-org/my-site/'));
    expect((await probeContentSource('my-org', 'my-site', signedFetch)).backend).toBe('da');
  });

  it('names the escape hatch when the session is not authorized', async () => {
    const { signedFetch } = stubFetch(new Response('', { status: 401 }));
    await expect(probeContentSource('adobe', 'aem-website', signedFetch)).rejects.toThrow(
      /--backend/
    );
  });

  it('throws on an unknown site', async () => {
    const { signedFetch } = stubFetch(new Response('', { status: 404 }));
    await expect(probeContentSource('adobe', 'nope', signedFetch)).rejects.toThrow(
      /no site config/
    );
  });

  it('throws on a non-JSON config', async () => {
    const { signedFetch } = stubFetch(new Response('<html>oops</html>', { status: 200 }));
    await expect(probeContentSource('adobe', 'aem-website', signedFetch)).rejects.toThrow(
      /not JSON/
    );
  });
});
