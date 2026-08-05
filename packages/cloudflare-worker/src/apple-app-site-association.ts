/**
 * Apple App Site Association for the iOS follower's universal links
 * (#1918): https://(www.)sliccy.ai/app/* opens SliccFollower when the
 * associated-domains entitlement is provisioned. Served unsigned JSON per
 * Apple's modern format; the CDN path (`/.well-known/…`) must stay
 * reachable by the worker's fetch, not the asset/SPA intercept.
 *
 * S8LB56P782 is the team id every SLICC Apple artifact ships under (see
 * the iCloud KVS id in packages/ios-app CLAUDE.md).
 */
const ASSOCIATION = {
  applinks: {
    details: [
      {
        appIDs: ['S8LB56P782.com.sliccy.follower'],
        components: [{ '/': '/app/*' }],
      },
    ],
  },
};

export function buildAppSiteAssociationResponse(request: Request): Response {
  const body = request.method === 'HEAD' ? null : JSON.stringify(ASSOCIATION);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Apple's CDN refetches on its own schedule; an hour keeps manual
      // iterations (mode=developer) tolerable without hammering the worker.
      'cache-control': 'public, max-age=3600',
    },
  });
}
