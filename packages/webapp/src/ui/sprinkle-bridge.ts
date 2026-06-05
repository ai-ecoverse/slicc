/**
 * Sprinkle Bridge — API available to `.shtml` sprinkle scripts for
 * communicating with the agent via lick events.
 */

import type { EntryType, VirtualFS } from '../fs/index.js';
import {
  getNavigatorHid,
  getSharedHidRegistry,
  type HidDeviceFilter,
  type HidDeviceInfo,
} from '../kernel/hid-device-registry.js';
import * as hidOps from '../kernel/hid-operations.js';
import * as serialOps from '../kernel/serial-operations.js';
import {
  getNavigatorSerial,
  getSharedSerialRegistry,
  type SerialDeviceInfo,
  type SerialFilter,
  type SerialOpenOptions,
} from '../kernel/serial-port-registry.js';
import {
  getNavigatorUsb,
  getSharedUsbRegistry,
  type UsbDeviceFilter,
  type UsbDeviceInfo,
} from '../kernel/usb-device-registry.js';
import * as usbOps from '../kernel/usb-operations.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import { toPreviewUrl } from '../shell/supplemental-commands/shared.js';

export interface CaptureScreenResult {
  base64: string;
  width: number;
  height: number;
  mimeType: string;
}

/** Result of a sprinkle `exec()` shell command. */
export interface SprinkleExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Options accepted by the sprinkle `agent()` helper. */
export interface SprinkleAgentOptions {
  /** Working directory for the spawned scoop (defaults to `.`). */
  cwd?: string;
  /** Comma-separated allow-list of bash commands (defaults to `*`). */
  allowedCommands?: string;
  /** Override the model id used by the spawned scoop. */
  model?: string;
  /** Reasoning / thinking level (off, minimal, low, medium, high, xhigh). */
  thinking?: string;
  /** Comma-separated VFS paths exposed read-only (pure-replace; see `agent` help). */
  readOnly?: string;
}

/** Result of a sprinkle `agent()` spawn. */
export interface SprinkleAgentResult {
  stdout: string;
  exitCode: number;
}

/**
 * Serializable subset of `RequestInit` accepted by `slicc.fetch`. Only
 * the shapes that round-trip cleanly through the page→worker bridge are
 * supported — non-serializable bodies (FormData, Blob, streams) are out
 * of scope; pass a string (or pre-encoded payload) instead.
 */
export interface SprinkleFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Internal wire/transport shape carried by the bridge for `slicc.fetch`.
 * The body is base64-encoded so binary responses survive the
 * JSON/postMessage transport between the realm worker and the page.
 * This is NOT the public return of `slicc.fetch` — the page-side
 * `jshDispatch` rebuilds a native `Response` from these fields before
 * returning to the sprinkle. Unlike the iframe's CORS-bound native
 * `fetch`, this routes through the worker shell's proxied,
 * secret-injecting fetch.
 */
export interface SprinkleFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  /** Raw response body, base64-encoded (use for binary payloads). */
  bodyBase64: string;
}

/** Per-request options accepted by the `slicc.http` client methods. */
export interface SprinkleHttpRequestOpts {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * Config for `slicc.http.client`. Mirrors the realm `http` global, but
 * `token` is a plain string (function tokens can't cross the bridge).
 */
export interface SprinkleHttpClientConfig {
  baseUrl?: string;
  token?: string;
  headers?: Record<string, string>;
  retry?: { on: number[]; maxAttempts: number };
  timeoutMs?: number;
}

/** Structured `slicc.http` response (always returned in `raw` shape). */
export interface SprinkleHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** API-client surface returned by `slicc.http.client(config)`. */
export interface SprinkleHttpClient {
  get(path: string, opts?: SprinkleHttpRequestOpts): Promise<SprinkleHttpResponse>;
  post(path: string, opts?: SprinkleHttpRequestOpts): Promise<SprinkleHttpResponse>;
  put(path: string, opts?: SprinkleHttpRequestOpts): Promise<SprinkleHttpResponse>;
  patch(path: string, opts?: SprinkleHttpRequestOpts): Promise<SprinkleHttpResponse>;
  delete(path: string, opts?: SprinkleHttpRequestOpts): Promise<SprinkleHttpResponse>;
}

/** `slicc.http` — the higher-level API-client builder over the proxied fetch. */
export interface SprinkleHttp {
  client(config: SprinkleHttpClientConfig): SprinkleHttpClient;
}

/**
 * `slicc.browser` — Playwright-style CDP surface mirroring the realm
 * `browser` global. Trusted-only (sprinkles + trusted dips). `eval` /
 * `evalAsync` take a code string (functions can't cross the bridge);
 * the chainable `websocket` observer is intentionally out of scope.
 */
export interface SprinkleBrowserApi {
  findTab(query: { domain?: string; urlMatch?: string }): Promise<unknown>;
  ensureTab(url: string, options?: { matchUrl?: string }): Promise<unknown>;
  eval(tab: unknown, code: string): Promise<unknown>;
  evalAsync(tab: unknown, code: string): Promise<unknown>;
  cookie(tab: unknown, name: string): Promise<string | null>;
  localStorage(tab: unknown, key: string): Promise<string | null>;
  fetch(tab: unknown, url: string, opts?: Record<string, unknown>): Promise<unknown>;
}

/** Callable `slicc.exec` with the array-form `spawn` companion. */
export interface SprinkleExecFn {
  (cmd: string): Promise<SprinkleExecResult>;
  /** Array-form exec that bypasses shell parsing (safer for untrusted args). */
  spawn(argv: string[]): Promise<SprinkleExecResult>;
}

/**
 * Pushed HID input-report payload delivered to listeners registered via
 * `slicc.hid.on('inputreport', cb)`. `data` is a `Uint8Array` so it
 * survives structured-clone across the host→iframe push channel.
 */
export interface SprinkleHidInputReport {
  handle: string;
  reportId: number;
  data: Uint8Array;
}

export type SprinkleHidInputReportListener = (report: SprinkleHidInputReport) => void;

/**
 * `slicc.hid` — stateful WebHID surface. `list`/`request`/`open`/`close`/
 * `sendReport` dispatch page-direct against the shared page-side
 * registry (same singleton the worker reaches via panel-RPC). `open`
 * auto-attaches an `inputreport` listener so reports flow to every
 * `on('inputreport', cb)` callback for the lifetime of the sprinkle;
 * `close` (or `removeSprinkle`) tears the subscription down.
 */
export interface SprinkleHidApi {
  list(): Promise<HidDeviceInfo[]>;
  request(filters?: HidDeviceFilter[]): Promise<HidDeviceInfo[]>;
  open(handle: string): Promise<void>;
  close(handle: string): Promise<void>;
  sendReport(handle: string, reportId: number, data: Uint8Array): Promise<void>;
  on(event: 'inputreport', cb: SprinkleHidInputReportListener): void;
  off(event: 'inputreport', cb: SprinkleHidInputReportListener): void;
}

/**
 * `slicc.serial` — parity surface for Web Serial. Mirrors the realm
 * `serial` global's `list`/`request`/`open`/`close` shape; streaming
 * reads/writes stay on the realm-side API for v1.
 */
export interface SprinkleSerialApi {
  list(): Promise<SerialDeviceInfo[]>;
  request(filters?: SerialFilter[]): Promise<SerialDeviceInfo>;
  open(handle: string, options: SerialOpenOptions): Promise<void>;
  close(handle: string): Promise<void>;
}

/**
 * `slicc.usb` — parity surface for WebUSB. Mirrors the realm `usb`
 * global's `list`/`request`/`open`/`close` shape; control/bulk
 * transfers stay on the realm-side API for v1.
 */
export interface SprinkleUsbApi {
  list(): Promise<UsbDeviceInfo[]>;
  request(filters?: UsbDeviceFilter[]): Promise<UsbDeviceInfo>;
  open(handle: string): Promise<void>;
  close(handle: string): Promise<void>;
}

// ── Tier 1 jsh bridge: node -e command builder + result parser ──
//
// The high-value jsh globals (`fetch`, `http`, `browser`, `exec.spawn`,
// `fetchToFile`) live in the worker realm, not the page. We reach them
// by composing a single `node -e` program that runs in the same worker
// shell `slicc.exec()` uses, prints one sentinel-prefixed JSON line, and
// is parsed back here. Shared with trusted dips (see `dip.ts`).

/** Sentinel marking the start of the JSON result on the realm's stdout. */
export const JSH_RESULT_PREFIX = '\u0001SLICCJSH\u0001';

/** Single-quote a value for safe inclusion in a `node -e '…'` argument. */
function jshShellQuote(value: string): string {
  if (value.length === 0) return `''`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the self-contained realm program for a Tier 1 jsh `op`. Args are
 * embedded as a JSON literal (so inner values are never shell-parsed) and
 * the structured result is written to stdout behind {@link JSH_RESULT_PREFIX}.
 *
 * The program uses TOP-LEVEL `await` rather than a detached `(async()=>{…})()`
 * IIFE: the realm runner (`kernel/realm/js-realm-shared.ts:runJsRealm`) wraps
 * `init.code` in an `AsyncFunction` body and awaits ONLY that body before
 * posting `realm-done`. An un-awaited IIFE promise lets the realm flush
 * stdout and exit before `await fetch`/`emit()` runs, so the sentinel never
 * lands. Keeping the `try/catch → emit({ok:false,error})` shape ensures
 * realm errors still serialize through the sentinel instead of falling
 * through to the realm's stderr/exit-1 path.
 */
export function buildJshNodeScript(op: string, args: unknown[]): string {
  const req = JSON.stringify({ op, args });
  return (
    `var REQ=${req};var P=${JSON.stringify(JSH_RESULT_PREFIX)};` +
    'function emit(o){process.stdout.write(P+JSON.stringify(o));}' +
    'try{var op=REQ.op,a=REQ.args||[],out;' +
    "if(op==='fetch'){" +
    'var r=await fetch(a[0],a[1]||undefined);' +
    'var h={};r.headers.forEach(function(v,k){h[k]=v;});' +
    'var u=new Uint8Array(await r.arrayBuffer());' +
    'var bin="",C=0x8000;for(var i=0;i<u.length;i+=C){bin+=String.fromCharCode.apply(null,u.subarray(i,i+C));}' +
    'out={ok:r.ok,status:r.status,statusText:r.statusText,url:r.url,headers:h,bodyBase64:btoa(bin)};' +
    "}else if(op==='http'){" +
    'var c=http.client(a[0]||{});' +
    'var res=await c[a[1]](a[2],Object.assign({},a[3]||{},{raw:true}));' +
    'out={status:res.status,headers:res.headers,body:res.body};' +
    "}else if(op==='browser'){" +
    'var m=a[0];if(typeof browser[m]!=="function")throw new Error("browser."+m+" is not available over the sprinkle bridge");' +
    'out=await browser[m].apply(browser,a.slice(1));' +
    "}else if(op==='spawn'){out=await exec.spawn(a[0]);" +
    "}else if(op==='fetchToFile'){out=await fs.fetchToFile(a[0],a[1]);" +
    '}else{throw new Error("unknown jsh op: "+op);}' +
    'emit({ok:true,value:out});' +
    '}catch(e){emit({ok:false,error:(e&&e.message)?e.message:String(e)});}'
  );
}

/** Wrap {@link buildJshNodeScript} as a `node -e '…'` shell command. */
export function buildJshNodeCommand(op: string, args: unknown[]): string {
  return `node -e ${jshShellQuote(buildJshNodeScript(op, args))}`;
}

/** Parse the realm's stdout into the op's return value (throws on error). */
export function parseJshResult(result: SprinkleExecResult): unknown {
  const idx = result.stdout.lastIndexOf(JSH_RESULT_PREFIX);
  if (idx === -1) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`jsh bridge: no result (${detail})`);
  }
  let parsed: { ok: boolean; value?: unknown; error?: string };
  try {
    parsed = JSON.parse(result.stdout.slice(idx + JSH_RESULT_PREFIX.length));
  } catch {
    throw new Error('jsh bridge: malformed result');
  }
  if (!parsed.ok) throw new Error(parsed.error || 'jsh bridge error');
  return parsed.value;
}

/** Run a Tier 1 jsh `op` over the supplied page→worker exec transport. */
export async function runJshOp(
  exec: (cmd: string) => Promise<SprinkleExecResult>,
  op: string,
  args: unknown[]
): Promise<unknown> {
  return parseJshResult(await exec(buildJshNodeCommand(op, args)));
}

/** Base64-encode bytes for transport across the page→iframe boundary. */
function u8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Decode a base64 string back into bytes. */
function base64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Coerce a Uint8Array / ArrayBuffer / ArrayBufferView / number[] argument
 * (whichever shape survives a postMessage round trip) into a Uint8Array
 * suitable for the kernel device ops.
 */
function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  throw new Error('expected Uint8Array, ArrayBuffer, or number[]');
}

/** Statuses that the `Response` constructor forbids carrying a body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Build a native `Response` page-side from the bridge's wire shape.
 * Handles null-body statuses (101/103/204/205/304) by passing `null`
 * for the body, and statuses outside the `Response` constructor's
 * accepted `[200,599]` range by constructing a default-status Response
 * and shadowing `status`/`statusText`/`ok` (and `url`) via own data
 * props. `Response.url` is a read-only prototype getter; an own data
 * prop shadows it for property reads while native `.text()`/`.json()`/
 * `.arrayBuffer()`/`.blob()` still read the internal body.
 */
function buildFetchResponse(v: SprinkleFetchResult): Response {
  const bytes = base64ToU8(v.bodyBase64);
  const body: BodyInit | null = NULL_BODY_STATUSES.has(v.status) ? null : (bytes as BodyInit);
  const headers = new Headers(v.headers);
  let resp: Response;
  try {
    resp = new Response(body, { status: v.status, statusText: v.statusText, headers });
    Object.defineProperty(resp, 'url', { value: v.url, configurable: true });
    return resp;
  } catch {
    resp = new Response(body, { headers });
    const ok = v.status >= 200 && v.status < 300;
    Object.defineProperty(resp, 'status', { value: v.status, configurable: true });
    Object.defineProperty(resp, 'statusText', { value: v.statusText, configurable: true });
    Object.defineProperty(resp, 'ok', { value: ok, configurable: true });
    Object.defineProperty(resp, 'url', { value: v.url, configurable: true });
    return resp;
  }
}

/**
 * Page→worker shell-exec transport. Runs `cmd` in the same worker
 * shell used by `.jsh` / `node -e` (so all supplemental commands and
 * `.jsh` scripts are reachable) and resolves with the captured output.
 * Wired by `ui/main.ts` over a `TerminalSessionClient`; left unset in
 * tests / environments without a worker shell, where `exec`/`agent`
 * surface a clean "shell bridge not available" result instead.
 */
export type SprinkleExecHandler = (cmd: string) => Promise<SprinkleExecResult>;

export interface SprinkleBridgeAPI {
  /** Send a lick event to the agent. Accepts {action, data} or a plain action string. */
  lick(event: { action: string; data?: unknown } | string): void;
  /** Listen for updates from the agent */
  on(event: 'update', callback: (data: unknown) => void): void;
  /** Remove an update listener */
  off(event: 'update', callback: (data: unknown) => void): void;
  /** Read a file from VFS */
  readFile(path: string): Promise<string>;
  /** Write text content to a VFS file */
  writeFile(path: string, content: string): Promise<void>;
  /** List directory entries */
  readDir(path: string): Promise<Array<{ name: string; type: EntryType }>>;
  /** Check if a path exists */
  exists(path: string): Promise<boolean>;
  /** Get file/directory metadata */
  stat(path: string): Promise<{ type: EntryType; size: number }>;
  /** Create a directory (recursive) */
  mkdir(path: string): Promise<void>;
  /** Remove a file */
  rm(path: string): Promise<void>;
  /** Capture sprinkle DOM as base64 PNG data URL */
  screenshot(selector?: string): Promise<string>;
  /** @internal Container element set by the renderer for inline mode screenshots. */
  _container?: HTMLElement;
  /** Persist sprinkle state (survives side panel close/reopen). */
  setState(data: unknown): void;
  /** Read persisted sprinkle state (null if none saved). */
  getState(): unknown;
  /** Open a VFS file in a browser tab via the preview service worker. */
  open(path: string, opts?: { projectRoot?: string }): void;
  /** Close this sprinkle */
  close(): void;
  /** Collapse the sprinkle panel (rail icon stays visible; user can click to reopen). Does not close or destroy the sprinkle. */
  minimize(): void;
  /** Stop the cone agent */
  stopCone(): void;
  /** Push an image into the chat input as a pending attachment (no agent turn). */
  attachImage(base64: string, name?: string, mimeType?: string): void;
  /** Capture a screen/window/tab via Chrome's native picker. Returns base64 PNG + metadata. */
  captureScreen(): Promise<CaptureScreenResult>;
  /**
   * Run a shell command in the same worker shell used by `.jsh` /
   * `node -e` and resolve with the captured stdout/stderr + exit code.
   * All supplemental commands and `.jsh` scripts are reachable. A
   * non-zero `exitCode` (or a missing shell bridge → `127`) is returned
   * in the result rather than thrown, so callers handle failures inline.
   */
  exec: SprinkleExecFn;
  /**
   * Spawn a sub-scoop, feed it `prompt`, block until it completes, and
   * resolve with the scoop's final message on `stdout`. Sugar over
   * {@link SprinkleBridgeAPI.exec} that builds the `agent` shell command
   * from `opts` (`--model` / `--thinking` / `--read-only`, plus the
   * `<cwd> <allowed-commands> <prompt>` positionals; `cwd` defaults to
   * `.` and `allowedCommands` to `*`). On failure the error text is
   * returned on `stdout` with a non-zero `exitCode` — never thrown.
   */
  agent(prompt: string, opts?: SprinkleAgentOptions): Promise<SprinkleAgentResult>;
  /**
   * Proxied, secret-injecting `fetch` (NOT the iframe's CORS-bound
   * native fetch). Routes through the same worker-shell fetch proxy used
   * by `node -e` / `.jsh`. Resolves with a native `Response` (built
   * page-side from the decoded body); rejects on transport failure.
   */
  fetch(url: string, init?: SprinkleFetchInit): Promise<Response>;
  /** Higher-level API-client builder layered on the proxied fetch. */
  http: SprinkleHttp;
  /**
   * Playwright-style CDP browser surface. Trusted-only — untrusted dips
   * and followers reject. Mirrors the realm `browser` global.
   */
  browser: SprinkleBrowserApi;
  /**
   * Stateful WebHID surface. `open` auto-attaches an `inputreport`
   * listener; reports arrive on every `on('inputreport', cb)` callback
   * until the sprinkle is closed. See {@link SprinkleHidApi}.
   */
  hid: SprinkleHidApi;
  /** Web Serial parity surface. See {@link SprinkleSerialApi}. */
  serial: SprinkleSerialApi;
  /** WebUSB parity surface. See {@link SprinkleUsbApi}. */
  usb: SprinkleUsbApi;
  /** Read a VFS file as raw bytes (binary parity with jsh `fs`). */
  readFileBinary(path: string): Promise<Uint8Array>;
  /** Write raw bytes to a VFS file (binary parity with jsh `fs`). */
  writeFileBinary(path: string, bytes: Uint8Array): Promise<void>;
  /** Download a URL (via the proxied fetch) straight to a VFS file; resolves with byte count. */
  fetchToFile(url: string, path: string): Promise<number>;
  /**
   * @internal Generic relay dispatch for Tier 1 jsh globals. The renderer
   * calls this in iframe modes; the public sugar above also routes through
   * it so CLI/inline and sandbox/extension floats share one code path.
   */
  _jsh(op: string, args: unknown[]): Promise<unknown>;
  /**
   * @internal Generic relay dispatch for the `slicc.{hid,serial,usb}`
   * device namespaces. The renderer calls this for iframe-mode
   * sprinkles; the public `hid`/`serial`/`usb` sugar above also routes
   * through the same per-channel dispatchers on the bridge, so CLI/
   * inline and sandbox/extension floats share one code path.
   */
  _device(channel: 'hid' | 'serial' | 'usb', op: string, args: unknown[]): Promise<unknown>;
  /** Sprinkle name */
  readonly name: string;
}

/**
 * Single-quote a value for safe inclusion in a bash command line.
 * Wraps in `'…'` and escapes embedded single quotes as `'\''`. Empty
 * input becomes `''` so the token is still well-formed.
 */
function shellQuote(value: string): string {
  if (value.length === 0) return `''`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type UpdateCallback = (data: unknown) => void;

/**
 * Optional hook the {@link SprinkleManager} wires to forward a
 * host-pushed device event (currently `hid:inputreport`) to the
 * sprinkle's iframe via the renderer's `pushDeviceEvent`. Inline-mode
 * sprinkles don't need this — their listeners are reached directly
 * through {@link SprinkleBridge.listeners}.
 */
export type SprinkleIframePusher = (
  sprinkleName: string,
  channel: string,
  payload: unknown
) => void;

export class SprinkleBridge {
  private listeners = new Map<string, Set<UpdateCallback>>();
  private lickHandler: (event: LickEvent) => void;
  private fs: VirtualFS;
  private closeHandler: (name: string) => void;
  private minimizeHandler: (name: string) => void;
  private stopConeHandler: () => void;
  private attachImageHandler: (base64: string, name?: string, mimeType?: string) => void;
  private captureScreenHandler: () => Promise<CaptureScreenResult>;
  private execHandler: SprinkleExecHandler | undefined;
  /**
   * Per-sprinkle HID input-report subscriptions, keyed by sprinkle name
   * then by device handle. Populated by `hid.open()`, torn down by
   * `hid.close()` and {@link removeSprinkle} so the host doesn't leak
   * `inputreport` listeners after the sprinkle goes away.
   */
  private hidSubs = new Map<string, Map<string, () => void | Promise<void>>>();
  private iframePusher: SprinkleIframePusher | undefined;

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent) => void,
    closeHandler: (name: string) => void,
    minimizeHandler: (name: string) => void,
    stopConeHandler: () => void,
    attachImageHandler: (base64: string, name?: string, mimeType?: string) => void,
    captureScreenHandler: () => Promise<CaptureScreenResult>,
    execHandler?: SprinkleExecHandler,
    iframePusher?: SprinkleIframePusher
  ) {
    this.fs = fs;
    this.lickHandler = lickHandler;
    this.closeHandler = closeHandler;
    this.minimizeHandler = minimizeHandler;
    this.stopConeHandler = stopConeHandler;
    this.attachImageHandler = attachImageHandler;
    this.captureScreenHandler = captureScreenHandler;
    this.execHandler = execHandler;
    this.iframePusher = iframePusher;
  }

  /**
   * Install (or replace) the iframe forwarder hook used by
   * {@link deliverHidInputReport}. The {@link SprinkleManager} wires
   * this so input reports reach iframe-mode sprinkles via
   * `renderer.pushDeviceEvent`. Inline-mode sprinkles ignore it.
   */
  setIframePusher(pusher: SprinkleIframePusher | undefined): void {
    this.iframePusher = pusher;
  }

  /**
   * Page-direct dispatch for the `slicc.hid` namespace. Uses the same
   * page-side `getSharedHidRegistry()` singleton the panel-RPC handlers
   * use, so handles created via the worker (`hid request` shell command)
   * are visible here and vice versa. `open` auto-subscribes the device
   * to input reports for this sprinkle; `close` tears the subscription
   * down (matches the DoD's `list → open → on('inputreport') →
   * sendReport` flow with no separate subscribe op).
   */
  private async hidOp(
    sprinkleName: string,
    op: string,
    args: readonly unknown[]
  ): Promise<unknown> {
    const reg = getSharedHidRegistry();
    switch (op) {
      case 'list': {
        const hid = getNavigatorHid();
        if (!hid) throw new Error('WebHID is unavailable in this browser');
        return hidOps.hidList(reg, hid);
      }
      case 'request': {
        const hid = getNavigatorHid();
        if (!hid) throw new Error('WebHID is unavailable in this browser');
        return hidOps.hidRequest(reg, hid, (args[0] as HidDeviceFilter[]) ?? []);
      }
      case 'info':
        return hidOps.hidDeviceInfo(reg, args[0] as string);
      case 'open': {
        const handle = args[0] as string;
        await hidOps.hidOpen(reg, handle);
        await this.attachHidInputReports(sprinkleName, handle);
        return { ok: true };
      }
      case 'close': {
        const handle = args[0] as string;
        await this.detachHidInputReports(sprinkleName, handle);
        await hidOps.hidClose(reg, handle);
        return { ok: true };
      }
      case 'sendReport': {
        const handle = args[0] as string;
        const reportId = args[1] as number;
        const bytes = toUint8Array(args[2]);
        const buf = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer;
        await hidOps.hidSendReport(reg, handle, reportId, buf);
        return { ok: true };
      }
      default:
        throw new Error(`hid: unknown op '${op}'`);
    }
  }

  /**
   * Page-direct dispatch for the `slicc.serial` namespace. Streaming
   * read/write stay on the realm-side `serial` global (out of scope
   * for v1 of the sprinkle device bridge).
   */
  private async serialOp(
    _sprinkleName: string,
    op: string,
    args: readonly unknown[]
  ): Promise<unknown> {
    const reg = getSharedSerialRegistry();
    switch (op) {
      case 'list': {
        const serial = getNavigatorSerial();
        if (!serial) throw new Error('Web Serial is unavailable in this browser');
        return serialOps.serialList(reg, serial);
      }
      case 'request': {
        const serial = getNavigatorSerial();
        if (!serial) throw new Error('Web Serial is unavailable in this browser');
        return serialOps.serialRequest(reg, serial, (args[0] as SerialFilter[]) ?? []);
      }
      case 'info':
        return serialOps.serialDeviceInfo(reg, args[0] as string);
      case 'open': {
        const handle = args[0] as string;
        const options = (args[1] as SerialOpenOptions) ?? { baudRate: 9600 };
        await serialOps.serialOpen(reg, handle, options);
        return { ok: true };
      }
      case 'close': {
        const handle = args[0] as string;
        await serialOps.serialClose(reg, handle);
        return { ok: true };
      }
      default:
        throw new Error(`serial: unknown op '${op}'`);
    }
  }

  /**
   * Page-direct dispatch for the `slicc.usb` namespace. Control / bulk
   * transfers stay on the realm-side `usb` global (out of scope for v1).
   */
  private async usbOp(
    _sprinkleName: string,
    op: string,
    args: readonly unknown[]
  ): Promise<unknown> {
    const reg = getSharedUsbRegistry();
    switch (op) {
      case 'list': {
        const usb = getNavigatorUsb();
        if (!usb) throw new Error('WebUSB is unavailable in this browser');
        return usbOps.usbList(reg, usb);
      }
      case 'request': {
        const usb = getNavigatorUsb();
        if (!usb) throw new Error('WebUSB is unavailable in this browser');
        return usbOps.usbRequest(reg, usb, (args[0] as UsbDeviceFilter[]) ?? []);
      }
      case 'info':
        return usbOps.usbDeviceInfo(reg, args[0] as string);
      case 'open': {
        await usbOps.usbOpen(reg, args[0] as string);
        return { ok: true };
      }
      case 'close': {
        await usbOps.usbClose(reg, args[0] as string);
        return { ok: true };
      }
      default:
        throw new Error(`usb: unknown op '${op}'`);
    }
  }

  /**
   * Generic page-side device dispatcher used by the renderer's
   * `sprinkle-{hid,serial,usb}-op` postMessage handler. Routes by
   * channel to the per-channel dispatch above.
   */
  async deviceOp(
    sprinkleName: string,
    channel: 'hid' | 'serial' | 'usb',
    op: string,
    args: readonly unknown[]
  ): Promise<unknown> {
    if (channel === 'hid') return this.hidOp(sprinkleName, op, args);
    if (channel === 'serial') return this.serialOp(sprinkleName, op, args);
    if (channel === 'usb') return this.usbOp(sprinkleName, op, args);
    throw new Error(`unknown device channel '${channel}'`);
  }

  /**
   * Subscribe to a device's input reports for `sprinkleName`. Idempotent:
   * a second attach for the same handle is a no-op so re-opens don't
   * leak listeners. The fan-out goes through
   * {@link deliverHidInputReport}.
   */
  private async attachHidInputReports(sprinkleName: string, handle: string): Promise<void> {
    let map = this.hidSubs.get(sprinkleName);
    if (!map) {
      map = new Map();
      this.hidSubs.set(sprinkleName, map);
    }
    if (map.has(handle)) return;
    const off = await hidOps.hidSubscribeInputReports(getSharedHidRegistry(), handle, (report) => {
      const bytes =
        report.bytes instanceof Uint8Array ? report.bytes : new Uint8Array(report.bytes);
      this.deliverHidInputReport(sprinkleName, {
        handle,
        reportId: report.reportId,
        data: bytes,
      });
    });
    map.set(handle, off);
  }

  /**
   * Tear down a single `inputreport` subscription. Safe to call when no
   * subscription exists (matching the close-is-implicit-cleanup model).
   */
  private async detachHidInputReports(sprinkleName: string, handle: string): Promise<void> {
    const map = this.hidSubs.get(sprinkleName);
    if (!map) return;
    const off = map.get(handle);
    if (off) {
      map.delete(handle);
      try {
        await Promise.resolve(off());
      } catch {
        /* best-effort teardown */
      }
    }
    if (map.size === 0) this.hidSubs.delete(sprinkleName);
  }

  /**
   * Fan an input report to (a) inline listeners registered through
   * `slicc.hid.on('inputreport', cb)` on the bridge, and (b) the
   * optional iframe forwarder so iframe-mode sprinkles receive the
   * same payload via postMessage.
   */
  private deliverHidInputReport(sprinkleName: string, report: SprinkleHidInputReport): void {
    const set = this.listeners.get(`${sprinkleName}:hid:inputreport`);
    if (set) {
      for (const cb of set) {
        const currentSet = set;
        setTimeout(() => {
          if (!currentSet.has(cb)) return;
          try {
            (cb as unknown as SprinkleHidInputReportListener)(report);
          } catch {
            /* ignore listener errors */
          }
        }, 0);
      }
    }
    try {
      this.iframePusher?.(sprinkleName, 'hid:inputreport', report);
    } catch {
      /* a broken pusher must not break delivery to other consumers */
    }
  }

  /**
   * Run a command via the injected shell-exec transport, surfacing a
   * clean `127` result when no handler is wired (rather than throwing).
   */
  private async runExec(cmd: string): Promise<SprinkleExecResult> {
    if (!this.execHandler) {
      return { stdout: '', stderr: 'exec: shell bridge not available\n', exitCode: 127 };
    }
    try {
      return await this.execHandler(cmd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `exec: ${message}\n`, exitCode: 1 };
    }
  }

  /**
   * Generic dispatch for the Tier 1 jsh globals. Binary VFS ops resolve
   * against the page-side `fs` directly (base64 on the wire); every
   * realm-backed op (`fetch`/`http`/`browser`/`spawn`/`fetchToFile`)
   * runs through a single `node -e` program over the shared exec
   * transport. Return values are structured-clone-safe so the renderer
   * can post them straight back to an iframe in extension mode.
   */
  private async jshDispatch(op: string, args: unknown[]): Promise<unknown> {
    if (op === 'readFileBinary') {
      const bytes = (await this.fs.readFile(args[0] as string, {
        encoding: 'binary',
      })) as Uint8Array;
      return { base64: u8ToBase64(bytes) };
    }
    if (op === 'writeFileBinary') {
      await this.fs.writeFile(args[0] as string, base64ToU8(args[1] as string));
      return true;
    }
    const value = await runJshOp((cmd) => this.runExec(cmd), op, args);
    if (op === 'fetch') {
      const v = value as SprinkleFetchResult;
      return buildFetchResponse(v);
    }
    return value;
  }

  /** Create a bridge API for a specific sprinkle. */
  createAPI(sprinkleName: string): SprinkleBridgeAPI {
    const api: SprinkleBridgeAPI = {
      name: sprinkleName,
      lick: (event: { action: string; data?: unknown } | string) => {
        const action = typeof event === 'string' ? event : event.action;
        const data = typeof event === 'string' ? undefined : event.data;
        const lickEvent: LickEvent = {
          type: 'sprinkle',
          sprinkleName,
          targetScoop: getSprinkleRoute(sprinkleName),
          timestamp: new Date().toISOString(),
          body: { action, data },
        };
        this.lickHandler(lickEvent);
      },
      on: (event: string, callback: UpdateCallback) => {
        const key = `${sprinkleName}:${event}`;
        let set = this.listeners.get(key);
        if (!set) {
          set = new Set();
          this.listeners.set(key, set);
        }
        set.add(callback);
      },
      off: (event: string, callback: UpdateCallback) => {
        const key = `${sprinkleName}:${event}`;
        this.listeners.get(key)?.delete(callback);
      },
      readFile: async (path: string) =>
        (await this.fs.readFile(path, { encoding: 'utf-8' })) as string,
      writeFile: async (path: string, content: string) => {
        await this.fs.writeFile(path, content);
      },
      readDir: async (path: string) => {
        const entries = await this.fs.readDir(path);
        return entries.map((e) => ({ name: e.name, type: e.type }));
      },
      exists: async (path: string) => this.fs.exists(path),
      stat: async (path: string) => {
        const s = await this.fs.stat(path);
        return { type: s.type, size: s.size };
      },
      mkdir: async (path: string) => {
        await this.fs.mkdir(path, { recursive: true });
      },
      rm: async (path: string) => {
        await this.fs.rm(path);
      },
      screenshot: async (selector?: string) => {
        const container = api._container;
        if (!container) return '';
        const target = selector ? container.querySelector<HTMLElement>(selector) : container;
        if (!target) throw new Error('Element not found: ' + (selector || 'container'));
        const rect = target.getBoundingClientRect();
        const w = Math.ceil(rect.width);
        const h = Math.ceil(rect.height);
        if (w === 0 || h === 0) throw new Error('Element has zero dimensions');
        const canvas = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        const ctx = canvas.getContext('2d')!;
        ctx.scale(dpr, dpr);
        const clone = (target as HTMLElement).cloneNode(true) as HTMLElement;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`;
        return new Promise<string>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/png'));
          };
          img.onerror = () => reject(new Error('Screenshot rendering failed'));
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        });
      },
      setState: (data: unknown) => {
        try {
          localStorage.setItem(`slicc-sprinkle-state:${sprinkleName}`, JSON.stringify(data));
        } catch {
          /* full */
        }
      },
      getState: (): unknown => {
        try {
          const raw = localStorage.getItem(`slicc-sprinkle-state:${sprinkleName}`);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      },
      open: (path: string) => {
        const url = /^https?:|^chrome-extension:/.test(path) ? path : toPreviewUrl(path);
        window.open(url, '_blank');
      },
      close: () => this.closeHandler(sprinkleName),
      minimize: () => this.minimizeHandler(sprinkleName),
      stopCone: () => this.stopConeHandler(),
      attachImage: (base64: string, name?: string, mimeType?: string) =>
        this.attachImageHandler(base64, name, mimeType),
      captureScreen: () => this.captureScreenHandler(),
      exec: Object.assign((cmd: string) => this.runExec(cmd), {
        spawn: (argv: string[]) => this.jshDispatch('spawn', [argv]) as Promise<SprinkleExecResult>,
      }) as SprinkleExecFn,
      fetch: (url: string, init?: SprinkleFetchInit) =>
        this.jshDispatch('fetch', [url, init ?? null]) as Promise<Response>,
      http: {
        client: (config: SprinkleHttpClientConfig): SprinkleHttpClient => {
          const make = (method: string) => (path: string, opts?: SprinkleHttpRequestOpts) =>
            this.jshDispatch('http', [
              config,
              method,
              path,
              opts ?? null,
            ]) as Promise<SprinkleHttpResponse>;
          return {
            get: make('get'),
            post: make('post'),
            put: make('put'),
            patch: make('patch'),
            delete: make('delete'),
          };
        },
      },
      browser: {
        findTab: (query) => this.jshDispatch('browser', ['findTab', query]),
        ensureTab: (url, options) => this.jshDispatch('browser', ['ensureTab', url, options ?? {}]),
        eval: (tab, code) => this.jshDispatch('browser', ['eval', tab, code]),
        evalAsync: (tab, code) => this.jshDispatch('browser', ['evalAsync', tab, code]),
        cookie: (tab, name) =>
          this.jshDispatch('browser', ['cookie', tab, name]) as Promise<string | null>,
        localStorage: (tab, key) =>
          this.jshDispatch('browser', ['localStorage', tab, key]) as Promise<string | null>,
        fetch: (tab, url, opts) => this.jshDispatch('browser', ['fetch', tab, url, opts ?? {}]),
      },
      hid: {
        list: () => this.hidOp(sprinkleName, 'list', []) as Promise<HidDeviceInfo[]>,
        request: (filters?: HidDeviceFilter[]) =>
          this.hidOp(sprinkleName, 'request', [filters ?? []]) as Promise<HidDeviceInfo[]>,
        open: async (handle: string) => {
          await this.hidOp(sprinkleName, 'open', [handle]);
        },
        close: async (handle: string) => {
          await this.hidOp(sprinkleName, 'close', [handle]);
        },
        sendReport: async (handle: string, reportId: number, data: Uint8Array) => {
          await this.hidOp(sprinkleName, 'sendReport', [handle, reportId, data]);
        },
        on: (event: 'inputreport', cb: SprinkleHidInputReportListener) => {
          if (event !== 'inputreport') return;
          const key = `${sprinkleName}:hid:inputreport`;
          let set = this.listeners.get(key);
          if (!set) {
            set = new Set();
            this.listeners.set(key, set);
          }
          set.add(cb as unknown as UpdateCallback);
        },
        off: (event: 'inputreport', cb: SprinkleHidInputReportListener) => {
          if (event !== 'inputreport') return;
          this.listeners
            .get(`${sprinkleName}:hid:inputreport`)
            ?.delete(cb as unknown as UpdateCallback);
        },
      },
      serial: {
        list: () => this.serialOp(sprinkleName, 'list', []) as Promise<SerialDeviceInfo[]>,
        request: (filters?: SerialFilter[]) =>
          this.serialOp(sprinkleName, 'request', [filters ?? []]) as Promise<SerialDeviceInfo>,
        open: async (handle: string, options: SerialOpenOptions) => {
          await this.serialOp(sprinkleName, 'open', [handle, options]);
        },
        close: async (handle: string) => {
          await this.serialOp(sprinkleName, 'close', [handle]);
        },
      },
      usb: {
        list: () => this.usbOp(sprinkleName, 'list', []) as Promise<UsbDeviceInfo[]>,
        request: (filters?: UsbDeviceFilter[]) =>
          this.usbOp(sprinkleName, 'request', [filters ?? []]) as Promise<UsbDeviceInfo>,
        open: async (handle: string) => {
          await this.usbOp(sprinkleName, 'open', [handle]);
        },
        close: async (handle: string) => {
          await this.usbOp(sprinkleName, 'close', [handle]);
        },
      },
      readFileBinary: async (path: string) =>
        base64ToU8(
          ((await this.jshDispatch('readFileBinary', [path])) as { base64: string }).base64
        ),
      writeFileBinary: async (path: string, bytes: Uint8Array) => {
        await this.jshDispatch('writeFileBinary', [path, u8ToBase64(bytes)]);
      },
      fetchToFile: (url: string, path: string) =>
        this.jshDispatch('fetchToFile', [url, path]) as Promise<number>,
      _jsh: (op: string, args: unknown[]) => this.jshDispatch(op, args),
      _device: (channel: 'hid' | 'serial' | 'usb', op: string, args: unknown[]) =>
        this.deviceOp(sprinkleName, channel, op, args),
      agent: async (prompt: string, opts?: SprinkleAgentOptions) => {
        const cwd = opts?.cwd ?? '.';
        const allowed = opts?.allowedCommands ?? '*';
        // Flags precede positionals — the `agent` parser treats the
        // third positional as the prompt verbatim, so any flags must
        // come first.
        const parts = ['agent'];
        if (opts?.model) parts.push('--model', shellQuote(opts.model));
        if (opts?.thinking) parts.push('--thinking', shellQuote(opts.thinking));
        if (opts?.readOnly) parts.push('--read-only', shellQuote(opts.readOnly));
        parts.push(shellQuote(cwd), shellQuote(allowed), shellQuote(prompt));
        const result = await this.runExec(parts.join(' '));
        // `agent` writes its final message to stdout on success and the
        // error text to stderr on failure; fold them into a single
        // `stdout` field so the sprinkle always sees the relevant text.
        return { stdout: result.stdout || result.stderr, exitCode: result.exitCode };
      },
    };
    return api;
  }

  /** Push data to a sprinkle's update listeners (async to prevent runaway callbacks from freezing the main thread). */
  pushUpdate(sprinkleName: string, data: unknown): void {
    const key = `${sprinkleName}:update`;
    const set = this.listeners.get(key);
    if (set) {
      for (const cb of set) {
        // Capture the set reference so the setTimeout callback can verify
        // the listener hasn't been removed via off() or removeSprinkle().
        const currentSet = set;
        setTimeout(() => {
          if (!currentSet.has(cb)) return;
          try {
            cb(data);
          } catch {
            /* ignore listener errors */
          }
        }, 0);
      }
    }
  }

  /**
   * Clean up listeners and device subscriptions for a sprinkle. Called
   * by the {@link SprinkleManager} on close so the host doesn't leak
   * `inputreport` listeners after the sprinkle goes away.
   */
  removeSprinkle(sprinkleName: string): void {
    for (const key of this.listeners.keys()) {
      if (key.startsWith(`${sprinkleName}:`)) {
        this.listeners.delete(key);
      }
    }
    const subs = this.hidSubs.get(sprinkleName);
    if (subs) {
      for (const off of subs.values()) {
        try {
          void Promise.resolve(off()).catch(() => {});
        } catch {
          /* best-effort teardown */
        }
      }
      this.hidSubs.delete(sprinkleName);
    }
  }
}

// ── Sprinkle → scoop routing config (localStorage-backed) ──

const SPRINKLE_ROUTES_KEY = 'slicc-sprinkle-routes';

function loadRoutes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SPRINKLE_ROUTES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveRoutes(routes: Record<string, string>): void {
  try {
    localStorage.setItem(SPRINKLE_ROUTES_KEY, JSON.stringify(routes));
  } catch {
    /* localStorage full */
  }
}

/** Get the target scoop for a sprinkle, or undefined (→ cone). */
export function getSprinkleRoute(sprinkleName: string): string | undefined {
  return loadRoutes()[sprinkleName];
}

/** Set the target scoop for a sprinkle's lick events. */
export function setSprinkleRoute(sprinkleName: string, scoop: string): void {
  const routes = loadRoutes();
  routes[sprinkleName] = scoop;
  saveRoutes(routes);
}

/** Clear the target scoop for a sprinkle (reverts to cone). */
export function clearSprinkleRoute(sprinkleName: string): void {
  const routes = loadRoutes();
  delete routes[sprinkleName];
  saveRoutes(routes);
}

/** Get all sprinkle → scoop routes. */
export function getAllSprinkleRoutes(): Record<string, string> {
  return loadRoutes();
}
