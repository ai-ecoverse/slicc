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

      'cache-control': 'public, max-age=3600',
    },
  });
}
