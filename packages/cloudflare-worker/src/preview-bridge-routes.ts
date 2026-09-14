import { PREVIEW_BRIDGE_JS } from './preview-bridge-assets.js';
import { type DurableObjectNamespaceLike, parseCapabilityToken } from './shared.js';

interface BridgeEnv {
  TRAY_HUB: DurableObjectNamespaceLike;
}

export async function handleBridgeRoute(
  request: Request,
  url: URL,
  env: BridgeEnv,
  previewToken: string,
  bridge: boolean,
  servingTrayId?: string
): Promise<Response | null> {
  if (!url.pathname.startsWith('/__slicc/') || !bridge) {
    return null;
  }

  const parsed = parseCapabilityToken(previewToken);
  if (!parsed) {
    return new Response('Invalid preview token', { status: 403 });
  }

  const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(servingTrayId ?? parsed.trayId));

  if (url.pathname === '/__slicc/preview-bridge.js' && request.method === 'GET') {
    return new Response(PREVIEW_BRIDGE_JS, {
      status: 200,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  if (url.pathname === '/__slicc/emit' && request.method === 'POST') {
    const body = await request.text();
    return stub.fetch(
      new Request('https://internal/internal/preview/emit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewToken, body }),
      })
    );
  }

  if (
    url.pathname === '/__slicc/bridge' &&
    request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  ) {
    return stub.fetch(request);
  }

  return null;
}

function insertBootstrapScript(html: string, scriptTag: string): string {
  const headOpen = html.match(/<head(?:\s[^>]*)?>/i);
  if (headOpen?.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + scriptTag + html.slice(at);
  }
  const anchor = html.match(/<body(?:\s[^>]*)?>|<html(?:\s[^>]*)?>|<!doctype[^>]*>/i);
  if (anchor?.index !== undefined) {
    const at = anchor.index + anchor[0].length;
    return html.slice(0, at) + scriptTag + html.slice(at);
  }

  return scriptTag + html;
}

export async function injectBridge(
  response: Response,
  opts: { previewToken: string; host: string; scheme: 'ws' | 'wss' }
): Promise<Response> {
  const { previewToken, host, scheme } = opts;
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('text/html')) {
    return response;
  }

  const scriptTag = `<script src="/__slicc/preview-bridge.js" data-slicc-token="${previewToken}" data-slicc-ws="${scheme}://${host}/__slicc/bridge"></script>`;

  try {
    let newBody: string;

    if (typeof HTMLRewriter !== 'undefined') {
      let injected = false;
      const rewriter = new HTMLRewriter()
        .on('head', {
          element(element) {
            if (!injected) {
              element.append(scriptTag, { html: true });
              injected = true;
            }
          },
        })
        .transform(response.clone());

      newBody = await rewriter.text();

      if (!injected) {
        newBody = insertBootstrapScript(newBody, scriptTag);
      }
    } else {
      const html = await response.clone().text();
      newBody = insertBootstrapScript(html, scriptTag);
    }

    const headers = new Headers(response.headers);
    const existingCsp = headers.get('content-security-policy') || '';
    let newCsp: string;

    const connectSrcMatch = existingCsp.match(/connect-src\s+([^;]+)/);
    if (connectSrcMatch) {
      const existingConnectSrc = connectSrcMatch[1];
      const augmented = `${existingConnectSrc} ${scheme}://${host}`;
      newCsp = existingCsp.replace(connectSrcMatch[0], `connect-src ${augmented}`);
    } else {
      newCsp = existingCsp + (existingCsp ? '; ' : '') + `connect-src 'self' ${scheme}://${host}`;
    }

    headers.set('content-security-policy', newCsp);

    return new Response(newBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}
