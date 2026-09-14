import { describe, expect, it } from 'vitest';
import { buildAppSiteAssociationResponse } from '../src/apple-app-site-association.js';

describe('apple-app-site-association', () => {
  it('serves the applinks payload for the follower app id', async () => {
    const res = buildAppSiteAssociationResponse(
      new Request('https://www.sliccy.ai/.well-known/apple-app-site-association')
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = (await res.json()) as {
      applinks: { details: Array<{ appIDs: string[]; components: Array<Record<string, string>> }> };
    };
    expect(body.applinks.details[0].appIDs).toEqual(['S8LB56P782.com.sliccy.follower']);
    expect(body.applinks.details[0].components).toEqual([{ '/': '/app/*' }]);
  });

  it('answers HEAD without a body', async () => {
    const res = buildAppSiteAssociationResponse(
      new Request('https://www.sliccy.ai/.well-known/apple-app-site-association', {
        method: 'HEAD',
      })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});
