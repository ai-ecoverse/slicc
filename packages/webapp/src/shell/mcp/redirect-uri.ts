import type { FloatTopology } from '../float-topology.js';

/** Hosted callback that treats MCP OAuth `state` as an opaque value. */
export const MCP_HOSTED_CALLBACK_PATH = '/auth/mcp-callback';

/**
 * Resolve the redirect URI shared by MCP DCR and subsequent OAuth flows.
 *
 * `topology` is injected rather than probed (#2276): this is a pure
 * derivation with no privileged operation behind it, so there is no
 * `CapabilityBroker` op for it — the caller resolves the float's topology
 * once, at the point it actually needs an OAuth redirect URI, the same way
 * it always has.
 */
export async function resolveMcpRedirectUri(topology: FloatTopology): Promise<string> {
  if (topology === 'extension-direct') {
    const chromeApi = chrome as unknown as {
      identity?: { getRedirectURL?: (path?: string) => string };
      runtime?: { id?: string };
    };
    return (
      chromeApi.identity?.getRedirectURL?.('mcp-callback') ??
      `https://${chromeApi.runtime?.id ?? ''}.chromiumapp.org/mcp-callback`
    );
  }

  if (topology === 'node-rest') {
    const { getLocalApiBaseUrl } = await import('../proxied-fetch.js');
    const localApiOrigin = getLocalApiBaseUrl();
    if (localApiOrigin) return `${localApiOrigin}/auth/callback`;
  }

  const { getOAuthPageOrigin } = await import('../../providers/oauth-service.js');
  const { origin } = await getOAuthPageOrigin();
  return `${origin}${topology === 'extension-delegate' ? MCP_HOSTED_CALLBACK_PATH : '/auth/callback'}`;
}
