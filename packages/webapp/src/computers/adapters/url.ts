/**
 * HTTP remote computer. All requests go through an injected fetch
 * (`createProxiedFetch` in production) so CLI and extension share a path.
 * Optional `WS /computer/frames` is native WebSocket; a failed or closed
 * socket falls back to screenshot polling so the host still receives frames.
 */

import type {
  ComputerCapabilities,
  ComputerDescriptor,
  ComputerFrame,
  ComputerInputEvent,
  ComputerMouseKind,
  ComputerState,
} from '@slicc/shared-ts';
import type { ComputerBackend, ComputerScreenshotOpts } from '../backend.js';
import { fitComputerFrame, jpegSize, pngSize } from '../encode-frame.js';

export type UrlComputerFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    signal?: AbortSignal;
  }
) => Promise<{
  status: number;
  headers: Headers | Record<string, string>;
  body: Uint8Array;
}>;

/** Subset of `SecureFetch` the production URL adapter actually uses. */
export type UrlSecureFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  status: number;
  headers: Headers | Record<string, string>;
  body: Uint8Array;
}>;

/**
 * Adapt `createProxiedFetch` (or any SecureFetch-shaped client) so URL-computer
 * calls keep `init.signal`. The previous wrapper dropped it, so the 8s timeout
 * could not cancel a stalled production fetch.
 */
export function wrapUrlComputerFetch(sf: UrlSecureFetch): UrlComputerFetch {
  return async (url, init) => {
    const res = await sf(url, {
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal,
    });
    return { status: res.status, headers: res.headers, body: res.body };
  };
}

/** Bound every URL-adapter HTTP call so probe/screenshot/text/input cannot hang. */
export const URL_REQUEST_TIMEOUT_MS = 8_000;

export function urlComputerSignal(extra?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(URL_REQUEST_TIMEOUT_MS);
  return extra ? AbortSignal.any([timeout, extra]) : timeout;
}

const DEFAULT_CAPS: ComputerCapabilities = {
  screenshot: true,
  text: false,
  frames: 'poll',
  keyboard: false,
  mouse: 'none',
  scroll: false,
  exec: false,
  inputAllowed: false,
};

export function normalizeComputerBase(spec: string): string {
  const parsed = new URL(spec);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http(s) bases');
  }
  let path = parsed.pathname.replace(/\/+$/u, '');
  if (path.endsWith('/computer')) path = path.slice(0, -'/computer'.length);
  parsed.pathname = path || '/';
  parsed.search = '';
  parsed.hash = '';
  const out = parsed.toString();
  if (parsed.pathname === '/' && out.endsWith('/')) return out.slice(0, -1);
  return out.replace(/\/+$/u, '');
}

export function urlComputerId(base: string): string {
  const parsed = new URL(normalizeComputerBase(base));
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `url:${parsed.host}${path}`;
}

export function headerGet(headers: Headers | Record<string, string>, name: string): string | null {
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function decodeJson(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function readBoolean(obj: object, key: string): boolean | undefined {
  if (!(key in obj)) return undefined;
  const value = Object.getOwnPropertyDescriptor(obj, key)?.value;
  return typeof value === 'boolean' ? value : undefined;
}

function readString(obj: object, key: string): string | undefined {
  if (!(key in obj)) return undefined;
  const value = Object.getOwnPropertyDescriptor(obj, key)?.value;
  return typeof value === 'string' ? value : undefined;
}

function readNumber(obj: object, key: string): number | undefined {
  if (!(key in obj)) return undefined;
  const value = Object.getOwnPropertyDescriptor(obj, key)?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseSize(value: unknown): ComputerDescriptor['size'] {
  if (typeof value !== 'object' || value === null) return null;
  const width = readNumber(value, 'width');
  const height = readNumber(value, 'height');
  if (!width || !height || width <= 0 || height <= 0) return null;
  return { width, height };
}

function parseCapabilities(value: unknown): ComputerCapabilities {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_CAPS };
  const mouse = readString(value, 'mouse');
  const frames = readString(value, 'frames');
  const mouseKind: ComputerMouseKind =
    mouse === 'absolute' || mouse === 'relative' || mouse === 'touch' || mouse === 'none'
      ? mouse
      : DEFAULT_CAPS.mouse;
  const frameKind =
    frames === 'push' || frames === 'poll' || frames === 'none' ? frames : DEFAULT_CAPS.frames;
  return {
    screenshot: readBoolean(value, 'screenshot') ?? DEFAULT_CAPS.screenshot,
    text: readBoolean(value, 'text') ?? DEFAULT_CAPS.text,
    frames: frameKind,
    keyboard: readBoolean(value, 'keyboard') ?? DEFAULT_CAPS.keyboard,
    mouse: mouseKind,
    scroll: readBoolean(value, 'scroll') ?? DEFAULT_CAPS.scroll,
    exec: readBoolean(value, 'exec') ?? DEFAULT_CAPS.exec,
    inputAllowed: readBoolean(value, 'inputAllowed') ?? DEFAULT_CAPS.inputAllowed,
  };
}

export function parseRemoteDescriptor(
  json: unknown,
  id: string,
  title: string
): ComputerDescriptor {
  const obj = typeof json === 'object' && json !== null ? json : {};
  const state = readString(obj, 'state');
  const remoteTitle = readString(obj, 'title');
  const sizeValue = 'size' in obj ? Object.getOwnPropertyDescriptor(obj, 'size')?.value : undefined;
  const capsValue =
    'capabilities' in obj ? Object.getOwnPropertyDescriptor(obj, 'capabilities')?.value : undefined;
  const allowedState: ComputerState =
    state === 'starting' || state === 'live' || state === 'paused' || state === 'gone'
      ? state
      : 'live';
  return {
    id,
    kind: 'url',
    title: remoteTitle && remoteTitle.length > 0 ? remoteTitle : title,
    size: parseSize(sizeValue),
    state: allowedState,
    capabilities: parseCapabilities(capsValue),
    pid: null,
  };
}

function sniffFrame(bytes: Uint8Array): {
  mime: ComputerFrame['mime'];
  width: number;
  height: number;
} | null {
  const png = pngSize(bytes);
  if (png) return { mime: 'image/png', ...png };
  const jpg = jpegSize(bytes);
  if (jpg) return { mime: 'image/jpeg', ...jpg };
  return null;
}

export async function probeUrlComputer(
  fetchImpl: UrlComputerFetch,
  base: string
): Promise<ComputerDescriptor> {
  const normalized = normalizeComputerBase(base);
  const id = urlComputerId(normalized);
  const res = await fetchImpl(`${normalized}/computer`, { signal: urlComputerSignal() });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GET /computer returned ${res.status}`);
  }
  return parseRemoteDescriptor(decodeJson(res.body), id, new URL(normalized).host);
}

export class UrlComputerBackend implements ComputerBackend {
  private seq = 0;
  private descriptor: ComputerDescriptor;
  readonly subscribe?: (
    fps: number,
    onFrame: (frame: ComputerFrame) => void,
    maxWidth?: number
  ) => () => void;

  constructor(
    private readonly fetchImpl: UrlComputerFetch,
    private readonly base: string,
    descriptor: ComputerDescriptor
  ) {
    this.descriptor = descriptor;
    if (descriptor.capabilities.frames === 'push') {
      this.subscribe = (fps, onFrame, maxWidth) => this.bindFrames(fps, onFrame, maxWidth);
    }
  }

  describe(): ComputerDescriptor {
    return this.descriptor;
  }

  async screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame> {
    const params = new URLSearchParams();
    params.set('format', opts.format);
    const res = await this.fetchImpl(`${this.base}/computer/screenshot?${params.toString()}`, {
      signal: urlComputerSignal(opts.signal),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GET /computer/screenshot returned ${res.status}`);
    }
    const sniffed = sniffFrame(res.body);
    if (!sniffed) throw new Error('remote screenshot was not PNG or JPEG');
    this.seq += 1;
    let frame: ComputerFrame = {
      seq: this.seq,
      mime: sniffed.mime,
      width: sniffed.width,
      height: sniffed.height,
      bytes: res.body,
    };
    if (opts.maxWidth) frame = await fitComputerFrame(frame, opts.maxWidth);
    if (!this.descriptor.size) {
      this.descriptor = {
        ...this.descriptor,
        size: { width: sniffed.width, height: sniffed.height },
      };
    }
    return frame;
  }

  async text(): Promise<string | null> {
    if (!this.descriptor.capabilities.text) return null;
    const res = await this.fetchImpl(`${this.base}/computer/text`, {
      signal: urlComputerSignal(),
    });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GET /computer/text returned ${res.status}`);
    }
    return new TextDecoder().decode(res.body);
  }

  async input(events: ComputerInputEvent[]): Promise<void> {
    if (!this.descriptor.capabilities.inputAllowed) throw new Error('input is not allowed');
    const res = await this.fetchImpl(`${this.base}/computer/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(events),
      signal: urlComputerSignal(),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`POST /computer/input returned ${res.status}`);
    }
  }

  async close(): Promise<void> {
    // HTTP computers hold no local tracks.
  }

  private bindFrames(
    fps: number,
    onFrame: (frame: ComputerFrame) => void,
    maxWidth?: number
  ): () => void {
    let closed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const startPoll = (): void => {
      if (closed || timer) return;
      const interval = Math.round(1000 / Math.max(1, fps));
      const poll = (): void => {
        if (closed) return;
        void this.screenshot({ format: 'jpeg', maxWidth }).then(onFrame, () => {
          /* keep polling after a missed shot */
        });
      };
      timer = setInterval(poll, interval);
      poll();
    };
    const stop = (): void => {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (typeof WebSocket === 'undefined') {
      startPoll();
      return stop;
    }
    const wsBase = this.base.replace(/^http/u, 'ws');
    const params = new URLSearchParams({ fps: String(fps) });
    if (maxWidth) params.set('maxWidth', String(maxWidth));
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${wsBase}/computer/frames?${params.toString()}`);
    } catch {
      startPoll();
      return stop;
    }
    ws.binaryType = 'arraybuffer';
    const onMessage = (event: MessageEvent<ArrayBuffer | Blob | string>): void => {
      void this.dispatchWsFrame(event.data, onFrame);
    };
    const onFail = (): void => {
      startPoll();
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onFail);
    ws.addEventListener('close', onFail);
    return () => {
      stop();
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onFail);
      ws.removeEventListener('close', onFail);
      ws.close();
    };
  }

  private async dispatchWsFrame(
    data: ArrayBuffer | Blob | string,
    onFrame: (frame: ComputerFrame) => void
  ): Promise<void> {
    let bytes: Uint8Array;
    if (typeof data === 'string') return;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else return;
    const sniffed = sniffFrame(bytes);
    if (!sniffed) return;
    this.seq += 1;
    onFrame({
      seq: this.seq,
      mime: sniffed.mime,
      width: sniffed.width,
      height: sniffed.height,
      bytes,
    });
  }
}
