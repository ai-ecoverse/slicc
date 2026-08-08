// IIFE entry for the CDP virtual-network overlay loader.
//
// Runs inside the `srcdoc` frame the controller opens when an Electron app
// blocks all renderer network egress (e.g. Signal). The renderer can make no
// network requests, so this loader boots the real hosted **follower** app with
// zero network: it installs a tunnelled `fetch`/`WebSocket` (relaying over a CDP
// binding to the controller, which has network), fetches the app's module graph
// over that tunnel, materializes every module as a `blob:` URL wired by an
// import map, and boots the entry module.
//
// STATUS: the pure graph transforms (`asset-graph.ts`) are unit-tested; this
// runtime glue is validated against a live egress-blocked Electron target
// through the `cdp-smoke-test` harness, not in CI (no headless equivalent of
// Signal's egress lockdown). Keep logic here thin and delegate to the tested
// pure helpers.
import {
  assetKey,
  buildAssetImportMap,
  crawlAssetGraph,
  extractHtmlModuleUrls,
  rewriteModuleSource,
} from './asset-graph.js';
import {
  TUNNEL_CONFIG_GLOBAL,
  TUNNEL_DELIVER_GLOBAL,
  TUNNEL_FRAME_REGISTER_GLOBAL,
  TUNNEL_SEND_GLOBAL,
  type TunnelConfig,
  type TunnelRequest,
  type TunnelResponse,
} from './tunnel-protocol.js';

interface TopRelay {
  [TUNNEL_SEND_GLOBAL]?: (json: string) => void;
  [TUNNEL_DELIVER_GLOBAL]?: (json: string) => void;
  [TUNNEL_FRAME_REGISTER_GLOBAL]?: (recv: (json: string) => void) => void;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Client end of the tunnel: request/response correlation + WS event fan-out. */
class TunnelClient {
  #nextId = 1;
  readonly #pending = new Map<number, (res: TunnelResponse) => void>();
  readonly #wsListeners = new Map<number, (res: TunnelResponse) => void>();
  readonly #send: (json: string) => void;

  constructor(send: (json: string) => void) {
    this.#send = send;
  }

  /** Dispatch a controller → frame message to its waiter / WS listener. */
  deliver(json: string): void {
    let msg: TunnelResponse;
    try {
      msg = JSON.parse(json) as TunnelResponse;
    } catch {
      return;
    }
    if (msg.op === 'fetch-res' || msg.op === 'fetch-err') {
      this.#pending.get(msg.id)?.(msg);
      this.#pending.delete(msg.id);
      return;
    }
    this.#wsListeners.get(msg.id)?.(msg);
  }

  #post(req: TunnelRequest): void {
    this.#send(JSON.stringify(req));
  }

  async fetch(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: Uint8Array | null
  ): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
    const id = this.#nextId++;
    const res = await new Promise<TunnelResponse>((resolve) => {
      this.#pending.set(id, resolve);
      this.#post({
        op: 'fetch',
        id,
        url,
        method,
        headers,
        bodyB64: body ? bytesToBase64(body) : null,
      });
    });
    if (res.op === 'fetch-err') throw new Error(res.message);
    if (res.op !== 'fetch-res') throw new Error('unexpected tunnel response');
    return { status: res.status, headers: res.headers, body: base64ToBytes(res.bodyB64) };
  }

  openWebSocket(url: string, protocols: string[], onEvent: (res: TunnelResponse) => void): number {
    const id = this.#nextId++;
    this.#wsListeners.set(id, onEvent);
    this.#post({ op: 'ws-open', id, url, protocols });
    return id;
  }
  wsSend(id: number, data: Uint8Array, binary: boolean): void {
    this.#post({ op: 'ws-send', id, dataB64: bytesToBase64(data), binary });
  }
  wsClose(id: number, code?: number): void {
    this.#post({ op: 'ws-close', id, code });
    this.#wsListeners.delete(id);
  }
}

/** Minimal `WebSocket` shim tunnelling frames through the controller. Covers the
 *  surface the bridge/tray client uses (`onopen/onmessage/onclose/onerror`,
 *  `addEventListener`, `send`, `close`, `readyState`, `protocol`). */
function makeTunneledWebSocket(client: TunnelClient, RealWS: typeof WebSocket): typeof WebSocket {
  class TunneledWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly url: string;
    readyState = 0;
    protocol = '';
    binaryType: BinaryType = 'blob';
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    #id: number;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this.url = String(url);
      const protos = protocols == null ? [] : Array.isArray(protocols) ? protocols : [protocols];
      this.#id = client.openWebSocket(this.url, protos, (res) => this.#onEvent(res));
    }
    #emit(type: string, ev: Event): void {
      (this as unknown as Record<string, ((e: Event) => void) | null>)[`on${type}`]?.(ev);
      this.dispatchEvent(ev);
    }
    #onEvent(res: TunnelResponse): void {
      if (res.op === 'ws-open-ack') {
        this.readyState = 1;
        this.protocol = res.protocol;
        this.#emit('open', new Event('open'));
      } else if (res.op === 'ws-msg') {
        const bytes = base64ToBytes(res.dataB64);
        const data = res.binary
          ? this.binaryType === 'arraybuffer'
            ? bytes.buffer
            : new Blob([bytes as unknown as BlobPart])
          : new TextDecoder().decode(bytes);
        this.#emit('message', new MessageEvent('message', { data }));
      } else if (res.op === 'ws-close') {
        this.readyState = 3;
        this.#emit('close', new CloseEvent('close', { code: res.code }));
      } else if (res.op === 'ws-err') {
        this.readyState = 3;
        this.#emit('error', new Event('error'));
      }
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (typeof data === 'string') {
        client.wsSend(this.#id, new TextEncoder().encode(data), false);
      } else if (data instanceof Blob) {
        void data.arrayBuffer().then((buf) => client.wsSend(this.#id, new Uint8Array(buf), true));
      } else {
        const buf = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data as ArrayBufferLike);
        client.wsSend(this.#id, buf, true);
      }
    }
    close(code?: number): void {
      this.readyState = 2;
      client.wsClose(this.#id, code);
    }
  }
  void RealWS;
  return TunneledWebSocket as unknown as typeof WebSocket;
}

/** Install a tunnelled `fetch` that only routes hosted-origin requests through
 *  the tunnel; blob/data URLs stay local. */
function makeTunneledFetch(
  client: TunnelClient,
  hostedOrigin: string,
  realFetch: typeof fetch
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('blob:') || url.startsWith('data:')) return realFetch(input, init);
    const abs = new URL(url, hostedOrigin).href;
    const method =
      (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')) ||
      'GET';
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let body: Uint8Array | null = null;
    if (init?.body != null) {
      if (typeof init.body === 'string') body = new TextEncoder().encode(init.body);
      else if (init.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
      else if (ArrayBuffer.isView(init.body)) body = new Uint8Array(init.body.buffer);
    }
    const res = await client.fetch(abs, method, headers, body);
    return new Response(res.body as unknown as BodyInit, {
      status: res.status,
      headers: res.headers,
    });
  }) as typeof fetch;
}

/** Rewrite `location`-derived reads so the follower app sees its `?tray=`/bridge
 *  params. `about:srcdoc` inherits the embedder base, so a relative
 *  `?…`-only `replaceState` stays same-origin. */
function virtualizeLocation(appUrl: string): void {
  try {
    const search = new URL(appUrl).search;
    if (search) history.replaceState(null, '', search);
  } catch {
    // Non-fatal: some params may not reach the app; surfaced during validation.
  }
}

async function boot(): Promise<void> {
  const config = (window as unknown as Record<string, TunnelConfig | undefined>)[
    TUNNEL_CONFIG_GLOBAL
  ];
  if (!config) {
    console.error('[slicc-tunnel] missing config');
    return;
  }
  const top = window.top as unknown as TopRelay | null;
  const send = top?.[TUNNEL_SEND_GLOBAL];
  const register = top?.[TUNNEL_FRAME_REGISTER_GLOBAL];
  if (!send || !register) {
    console.error('[slicc-tunnel] top-frame relay unavailable');
    return;
  }

  const client = new TunnelClient((json) => send(json));
  register((json) => client.deliver(json));

  const realFetch = window.fetch.bind(window);
  const RealWS = window.WebSocket;
  window.fetch = makeTunneledFetch(client, config.hostedOrigin, realFetch);
  window.WebSocket = makeTunneledWebSocket(client, RealWS);
  virtualizeLocation(config.appUrl);

  // Fetch the app index over the tunnel, seed + crawl the module graph.
  const indexHtml = new TextDecoder().decode(
    (await client.fetch(config.appUrl, 'GET', { Accept: 'text/html' }, null)).body
  );
  const { entry, seeds } = extractHtmlModuleUrls(indexHtml);
  if (!entry) {
    console.error('[slicc-tunnel] no module entry in app index');
    return;
  }
  const originResolve = (assetPath: string): string => new URL(assetPath, config.hostedOrigin).href;
  const graph = await crawlAssetGraph({
    seeds,
    fetchText: async (url) =>
      new TextDecoder().decode(
        (await client.fetch(url, 'GET', { Accept: 'text/javascript' }, null)).body
      ),
    originResolve,
    onError: (assetPath, error) =>
      console.warn('[slicc-tunnel] module fetch failed', assetPath, error),
  });

  // Materialize every module as a blob URL, rewrite specifiers to import-map keys.
  const pathToBlob = new Map<string, string>();
  for (const [assetPath, source] of graph) {
    const blob = new Blob([rewriteModuleSource(source)], { type: 'text/javascript' });
    pathToBlob.set(assetPath, URL.createObjectURL(blob));
  }

  // Inject the import map before booting so every specifier resolves to a blob.
  const importMap = document.createElement('script');
  importMap.type = 'importmap';
  importMap.textContent = JSON.stringify(buildAssetImportMap(pathToBlob));
  document.head.appendChild(importMap);

  const bootScript = document.createElement('script');
  bootScript.type = 'module';
  bootScript.textContent = `import ${JSON.stringify(assetKey(entry))};`;
  document.body.appendChild(bootScript);
}

void boot();
