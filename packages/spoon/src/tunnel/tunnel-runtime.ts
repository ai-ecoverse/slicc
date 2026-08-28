// Runtime for the CDP virtual-network overlay loader.
//
// Runs inside the `srcdoc` frame the controller opens when an Electron app
// blocks all renderer network egress (e.g. Signal). The renderer can make no
// network requests, so this loader boots the real hosted **follower** app with
// zero network: it installs a tunnelled `fetch`/`WebSocket` (relaying over a CDP
// binding to the controller, which has network), fetches the app's module graph
// over that tunnel, materializes every module as a `blob:` URL wired by an
// import map, and boots the entry module.
//
// Everything here takes its browser globals from an injected {@link TunnelEnv}
// (defaulting to the ambient frame) so the whole boot can run against a real
// but disposable `<iframe>` in tests — the egress-blocked Electron target it
// ships against has no headless equivalent. `tunnel-loader-entry.ts` is the
// thin IIFE that calls {@link boot} with the ambient environment.

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

/** The top-frame relay globals the controller installs (see tunnel-protocol). */
export interface TopRelay {
  [TUNNEL_SEND_GLOBAL]?: (json: string) => void;
  [TUNNEL_DELIVER_GLOBAL]?: (json: string) => void;
  [TUNNEL_FRAME_REGISTER_GLOBAL]?: (recv: (json: string) => void) => void;
}

/** Browser surface the loader touches; injected so tests can boot into a
 *  disposable frame instead of the ambient one. */
export interface TunnelEnv {
  /** The loader's own frame — its `fetch`/`WebSocket` are replaced in place.
   *  Typed as the frame's global object (not just `Window`) because the
   *  constructors it swaps live on `globalThis`, not on the `Window` interface. */
  win: Window & typeof globalThis;
  /** The top frame carrying the controller relay globals. */
  top: TopRelay | null | undefined;
  /** The loader frame's document — receives the import map + boot script. */
  doc: Document;
}

export function ambientTunnelEnv(): TunnelEnv {
  return { win: window, top: window.top as unknown as TopRelay | null, doc: document };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Statuses the Fetch spec forbids a body on — handing one to `new Response`
 *  throws, and the controller relays the real upstream status verbatim (a
 *  conditional asset request answering `304` is routine). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Client end of the tunnel: request/response correlation + WS event fan-out. */
export class TunnelClient {
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
    // Ids come from one counter shared by fetches and sockets, so an id in
    // `#pending` is unambiguously a fetch waiter — route by id, not by op. A
    // mis-routed frame then fails that fetch ("unexpected tunnel response")
    // instead of leaving its promise pending forever, which would hang the
    // boot with nothing logged.
    const waiter = this.#pending.get(msg.id);
    if (waiter) {
      this.#pending.delete(msg.id);
      waiter(msg);
      return;
    }
    this.#wsListeners.get(msg.id)?.(msg);
    // `ws-close` / `ws-err` are terminal: the socket can produce no further
    // events, so drop the listener here (and ONLY here — dropping it when the
    // frame asks to close would swallow the controller's close ack and the
    // shim's `onclose` would never fire).
    if (msg.op === 'ws-close' || msg.op === 'ws-err') this.#wsListeners.delete(msg.id);
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
  }
}

/** Minimal `WebSocket` shim tunnelling frames through the controller. Covers the
 *  surface the bridge/tray client uses (`onopen/onmessage/onclose/onerror`,
 *  `addEventListener`, `send`, `close`, `readyState`, `protocol`). */
export function makeTunneledWebSocket(client: TunnelClient): typeof WebSocket {
  class TunneledWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    // Instance copies too: `sock.readyState === sock.OPEN` is idiomatic and
    // reads `undefined` on a class that only has the statics.
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
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
      this.#id = client.openWebSocket(this.url, protos, (res) => {
        this.#onEvent(res);
      });
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
        this.#emit('close', new CloseEvent('close', { code: res.code, wasClean: true }));
      } else if (res.op === 'ws-err') {
        this.readyState = 3;
        this.#emit('error', new Event('error'));
        // A real socket always follows `error` with `close`, and the
        // controller sends no further frame for a failed socket (the client
        // drops the listener on this terminal op). Consumers drive recovery
        // from `onclose` — the bridge and CDP clients only *log* `onerror` —
        // so without this an error is a silent, permanent disconnect.
        this.#emit(
          'close',
          new CloseEvent('close', { code: 1006, reason: res.message, wasClean: false })
        );
      }
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      // A real socket ignores sends once closing/closed rather than pushing
      // frames at a peer that is gone.
      if (this.readyState >= 2) return;
      if (typeof data === 'string') {
        client.wsSend(this.#id, new TextEncoder().encode(data), false);
      } else if (data instanceof Blob) {
        void data.arrayBuffer().then((buf) => {
          client.wsSend(this.#id, new Uint8Array(buf), true);
        });
      } else {
        const buf = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data as ArrayBufferLike);
        client.wsSend(this.#id, buf, true);
      }
    }
    close(code?: number): void {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      client.wsClose(this.#id, code);
    }
  }
  return TunneledWebSocket as unknown as typeof WebSocket;
}

/** Install a tunnelled `fetch` that only routes hosted-origin requests through
 *  the tunnel; blob/data URLs stay local. */
export function makeTunneledFetch(
  client: TunnelClient,
  hostedOrigin: string,
  realFetch: typeof fetch
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('blob:') || url.startsWith('data:')) return realFetch(input, init);
    const abs = new URL(url, hostedOrigin).href;
    // Normalize through a `Request`: it applies the same method/header/body
    // precedence the platform would (including a `Request` passed as `input`
    // carrying its own body) and encodes every body type — string, Blob,
    // ArrayBuffer, a *view onto part of* a buffer, URLSearchParams, FormData —
    // instead of hand-rolling a few of them and silently dropping the rest.
    const request =
      typeof input === 'string' || input instanceof URL
        ? new Request(abs, init)
        : new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const bytes = new Uint8Array(await request.arrayBuffer());
    const res = await client.fetch(abs, request.method, headers, bytes.length ? bytes : null);
    if (res.status < 200 || res.status > 599) {
      throw new TypeError(`tunnelled fetch got an out-of-range status ${res.status} for ${abs}`);
    }
    const body = NULL_BODY_STATUSES.has(res.status) ? null : (res.body as unknown as BodyInit);
    return new Response(body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

/**
 * Rewrite `location`-derived reads so the follower app sees its `?tray=`/bridge
 * params.
 *
 * Best-effort by construction: an `about:srcdoc` document — the frame this
 * loader was written for — cannot host a history state object at all, so
 * Chromium answers `replaceState` with a `SecurityError` and the app boots
 * without its params. That failure is *loud* (a param-less follower looks like
 * an auth bug, not a plumbing one) and the loader continues either way; a frame
 * with a real URL (or a config that hands the params to the app another way) is
 * the fix, and neither belongs on this side of the tunnel.
 *
 * @returns whether the app's query is now visible on `win.location`.
 */
export function virtualizeLocation(win: Window, appUrl: string): boolean {
  let search = '';
  try {
    search = new URL(appUrl).search;
  } catch {
    return false; // not a URL — nothing to replay
  }
  if (!search) return false;
  try {
    win.history.replaceState(null, '', search);
    return true;
  } catch (error) {
    console.warn(
      '[slicc-tunnel] could not virtualize location; the app will not see',
      search,
      error
    );
    return false;
  }
}

/**
 * Boot the follower app inside the egress-blocked frame. Resolves once the
 * import map and the entry `<script type="module">` are in the document (module
 * evaluation itself is the browser's job). Never throws: every give-up path
 * logs and returns so a failed boot leaves the frame inspectable.
 */
export async function boot(env: TunnelEnv = ambientTunnelEnv()): Promise<void> {
  const { win, doc } = env;
  const config = (win as unknown as Record<string, TunnelConfig | undefined>)[TUNNEL_CONFIG_GLOBAL];
  if (!config) {
    console.error('[slicc-tunnel] missing config');
    return;
  }
  const send = env.top?.[TUNNEL_SEND_GLOBAL];
  const register = env.top?.[TUNNEL_FRAME_REGISTER_GLOBAL];
  if (!send || !register) {
    console.error('[slicc-tunnel] top-frame relay unavailable');
    return;
  }

  const client = new TunnelClient((json) => {
    send(json);
  });
  register((json) => {
    client.deliver(json);
  });

  const realFetch = win.fetch.bind(win);
  win.fetch = makeTunneledFetch(client, config.hostedOrigin, realFetch);
  win.WebSocket = makeTunneledWebSocket(client);
  virtualizeLocation(win, config.appUrl);

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
    onError: (assetPath, error) => {
      console.warn('[slicc-tunnel] module fetch failed', assetPath, error);
    },
  });

  // Materialize every module as a blob URL, rewrite specifiers to import-map keys.
  const pathToBlob = new Map<string, string>();
  for (const [assetPath, source] of graph) {
    const blob = new Blob([rewriteModuleSource(source)], { type: 'text/javascript' });
    pathToBlob.set(assetPath, URL.createObjectURL(blob));
  }

  // Inject the import map before booting so every specifier resolves to a blob.
  const importMap = doc.createElement('script');
  importMap.type = 'importmap';
  importMap.textContent = JSON.stringify(buildAssetImportMap(pathToBlob));
  doc.head.appendChild(importMap);

  const bootScript = doc.createElement('script');
  bootScript.type = 'module';
  bootScript.textContent = `import ${JSON.stringify(assetKey(entry))};`;
  doc.body.appendChild(bootScript);
}
