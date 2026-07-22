// GET /api/cloud/config — public, no auth. Returns IMS app identity + relay
// URL so the dashboard can construct its sign-in popup against environment-
// specific values without rebuilding the bundle per environment.

import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import { getProxyConfig } from './proxy-config.js';

export interface ConfigEnv {
  ADOBE_PROXY_ENDPOINT?: string;
  IMS_RELAY_URL?: string;
}

const IMS_AUTHORIZE_URLS: Record<string, string> = {
  prod: 'https://ims-na1.adobelogin.com/ims/authorize/v2',
  stg1: 'https://ims-na1-stg1.adobelogin.com/ims/authorize/v2',
};

const DEFAULT_RELAY_URL = `${SLICC_HOSTED_ORIGIN}/auth/callback`;
const RECEIVE_PATH = '/auth/cloud-callback';

export async function handleCloudConfig(_req: Request, env: ConfigEnv): Promise<Response> {
  try {
    const proxy = await getProxyConfig(env);
    const relayUrl = env.IMS_RELAY_URL || DEFAULT_RELAY_URL;
    return Response.json({
      imsClientId: proxy.clientId,
      imsEnvironment: proxy.imsEnvironment,
      imsAuthorizeUrl: IMS_AUTHORIZE_URLS[proxy.imsEnvironment] || IMS_AUTHORIZE_URLS.prod!,
      imsScope: proxy.scopes,
      imsRelayUrl: relayUrl,
      imsReceivePath: RECEIVE_PATH,
      // Adobe models from the proxy, so the dashboard can offer them without a
      // provider login (Adobe is configured by default from the IMS bearer).
      adobeModels: (proxy.models ?? []).map((m) => ({ id: m.id, name: m.name })),
    });
  } catch (err) {
    // Discriminate network/HTTP errors (transient, 502) from shape errors (config bug, 500).
    const isShapeError =
      err instanceof Error &&
      err.name === 'ProxyConfigError' &&
      'code' in err &&
      err.code === 'PROXY_SHAPE_ERROR';
    const errorCode = isShapeError ? 'PROXY_CONFIG_INVALID' : 'PROXY_CONFIG_UNAVAILABLE';
    const status = isShapeError ? 500 : 502;
    return Response.json(
      {
        error: errorCode,
        message: err instanceof Error ? err.message : String(err),
      },
      { status }
    );
  }
}
