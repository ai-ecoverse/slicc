import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import { getProxyConfig } from './proxy-config.js';

export interface ConfigEnv {
  ADOBE_PROXY_ENDPOINT?: string;
  IMS_RELAY_URL?: string;
  CONE_CAP_RUNNING?: string;
  CONE_CAP_PAUSED?: string;
}

const IMS_AUTHORIZE_URLS: Record<string, string> = {
  prod: 'https://ims-na1.adobelogin.com/ims/authorize/v2',
  stg1: 'https://ims-na1-stg1.adobelogin.com/ims/authorize/v2',
};

const DEFAULT_RELAY_URL = `${SLICC_HOSTED_ORIGIN}/auth/callback`;
const RECEIVE_PATH = '/auth/cloud-callback';

function parseCapLimit(name: string, raw: string | undefined, defaultVal: number): number {
  if (!raw) return defaultVal;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `Invalid cap env ${name}=${JSON.stringify(raw)}: must be a non-negative integer`
    );
  }
  return n;
}

export async function handleCloudConfig(_req: Request, env: ConfigEnv): Promise<Response> {
  let capRunning: number, capPaused: number;
  try {
    capRunning = parseCapLimit('CONE_CAP_RUNNING', env.CONE_CAP_RUNNING, 1);
    capPaused = parseCapLimit('CONE_CAP_PAUSED', env.CONE_CAP_PAUSED, 5);
  } catch (err) {
    return Response.json(
      {
        error: 'WORKER_CONFIG_INVALID',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }

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
      capRunning,
      capPaused,

      adobeModels: (proxy.models ?? []).map((m) => ({ id: m.id, name: m.name })),
    });
  } catch (err) {
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
