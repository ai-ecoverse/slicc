import type { FloatTopology } from '../float-topology.js';

export const MCP_HOSTED_CALLBACK_PATH = '/auth/mcp-callback';

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
