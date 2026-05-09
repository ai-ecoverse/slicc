/**
 * `GET /.well-known/api-catalog` — RFC 9727 / RFC 9264 linkset describing
 * the public surface of the SLICC tray hub.
 *
 * The catalog enumerates every documented public route as one entry of
 * `linkset[].item[]`, with the entry's `anchor` set to the canonical path
 * and individual link relations attached as named members. A linkset
 * consumer (RFC 9264) walks `linkset[]` and inspects each anchor + rels
 * pair the same way it would walk a parsed `Link` header.
 */

interface CatalogEntry {
  anchor: string;
  methods: string[];
  description: string;
}

const ENTRIES: CatalogEntry[] = [
  {
    anchor: '/tray',
    methods: ['POST'],
    description: 'Create a tray; returns join/controller/webhook capability URLs.',
  },
  {
    anchor: '/handoff',
    methods: ['GET'],
    description:
      'Convenience endpoint for cross-agent handoff. Accepts ?upskill=, ?handoff=, or legacy ?msg=. Response carries an RFC 8288 Link header with the handoff or upskill rel.',
  },
  {
    anchor: '/join/:token',
    methods: ['GET', 'POST'],
    description: 'Follower join + bootstrap polling for a tray.',
  },
  {
    anchor: '/controller/:token',
    methods: ['GET', 'POST'],
    description: 'Leader attach for a tray; WebSocket upgrade for live signaling.',
  },
  {
    anchor: '/webhook/:token/:webhookId',
    methods: ['POST'],
    description: 'Forward webhook events to the live leader of a tray.',
  },
  {
    anchor: '/auth/callback',
    methods: ['GET'],
    description: 'OAuth callback relay; redirects to the localhost runtime.',
  },
  {
    anchor: '/oauth/token',
    methods: ['POST', 'OPTIONS'],
    description: 'Generic OAuth authorization-code grant exchange.',
  },
  {
    anchor: '/oauth/revoke',
    methods: ['POST', 'OPTIONS'],
    description: 'Generic OAuth token revocation.',
  },
  {
    anchor: '/api/runtime-config',
    methods: ['GET'],
    description: 'Public runtime configuration for the served webapp.',
  },
  {
    anchor: '/download/slicc.dmg',
    methods: ['GET', 'HEAD'],
    description: 'Latest macOS launcher download (302 to the GitHub release).',
  },
];

export function buildApiCatalogResponse(request: Request): Response {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const linkset = ENTRIES.map((entry) => ({
    anchor: `${origin}${entry.anchor}`,
    'http-method': entry.methods,
    description: [{ value: entry.description, lang: 'en' }],
  }));
  const body = JSON.stringify({ linkset }, null, 2);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/linkset+json',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
