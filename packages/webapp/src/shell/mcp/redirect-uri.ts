import { resolveFloatTopology } from '../float-topology.js';

/** Hosted callback that treats MCP OAuth `state` as an opaque value. */
export const MCP_HOSTED_CALLBACK_PATH = '/auth/mcp-callback';

/** Resolve the redirect URI shared by MCP DCR and subsequent OAuth flows. */
export async function resolveMcpRedirectUri(): Promise<string> {
  const topology = resolveFloatTopology();
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
