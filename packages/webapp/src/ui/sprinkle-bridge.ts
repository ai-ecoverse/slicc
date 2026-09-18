import type { EntryType, VirtualFS } from '../fs/index.js';
import {
  getNavigatorHid,
  getSharedHidRegistry,
  type HidDeviceFilter,
  type HidDeviceInfo,
} from '../kernel/hid-device-registry.js';
import * as hidOps from '../kernel/hid-operations.js';
import type { HttpQueryParams } from '../kernel/realm/http-global.js';
import type {
  BrowserFetchOptions,
  JsonEncodableObject,
} from '../kernel/realm/realm-browser-fetch.js';
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
  parseUsbSprinkleOwner,
  type UsbClaimEvent,
  type UsbControlSetup,
  type UsbDeviceFilter,
  type UsbDeviceInfo,
  usbSprinkleOwner,
} from '../kernel/usb-device-registry.js';
import * as usbOps from '../kernel/usb-operations.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import { toPreviewUrl } from '../shell/supplemental-commands/shared.js';
import { captureSprinkleScreenshot } from './sprinkle-screenshot.js';

export interface CaptureScreenResult {
  base64: string;
  width: number;
  height: number;
  mimeType: string;
}

export interface SprinkleExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SprinkleAgentOptions {
  cwd?: string;

  allowedCommands?: string;

  model?: string;

  thinking?: string;

  readOnly?: string;
}

export interface SprinkleAgentResult {
  stdout: string;
  exitCode: number;
}

export interface SprinkleFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface SprinkleFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;

  bodyBase64: string;
}

export interface SprinkleHttpRequestOpts {
  params?: HttpQueryParams;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface SprinkleHttpClientConfig {
  baseUrl?: string;
  token?: string;
  headers?: Record<string, string>;
  retry?: { on: number[]; maxAttempts: number };
  timeoutMs?: number;
}

export interface SprinkleHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface SprinkleHttpClient {
  get(path: string, opts?: SprinkleHttpRequestOpts): Promise<SprinkleHttpResponse>;
  post(path: string, opts?: SprinkleHttpRequestOpts): Promise<SprinkleHttpResponse>;
  put(path: string, opts?: SprinkleHttpRequestOpts): Promise<SprinkleHttpResponse>;
  patch(path: string, opts?: SprinkleHttpRequestOpts): Promise<SprinkleHttpResponse>;
  delete(path: string, opts?: SprinkleHttpRequestOpts): Promise<SprinkleHttpResponse>;
}

export interface SprinkleHttp {
  client(config: SprinkleHttpClientConfig): SprinkleHttpClient;
}

export interface SprinkleBrowserFetchOptions extends Omit<BrowserFetchOptions, 'body'> {
  body?: string | JsonEncodableObject | unknown[] | number | boolean | null;
}

export interface SprinkleBrowserApi {
  findTab(query: { domain?: string; urlMatch?: string }): Promise<unknown>;
  ensureTab(url: string, options?: { matchUrl?: string }): Promise<unknown>;
  openWindow(
    url: string,
    options?: {
      width?: number;
      height?: number;
      left?: number;
      top?: number;
      state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
      decorated?: boolean;
      focus?: boolean;
    }
  ): Promise<unknown>;
  windowBounds(tab: unknown): Promise<unknown>;
  setWindowBounds(
    tab: unknown,
    bounds: {
      left?: number;
      top?: number;
      width?: number;
      height?: number;
      state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
    }
  ): Promise<unknown>;
  eval(tab: unknown, code: string): Promise<unknown>;
  evalAsync(tab: unknown, code: string): Promise<unknown>;
  cookie(tab: unknown, name: string): Promise<string | null>;
  localStorage(tab: unknown, key: string): Promise<string | null>;
  fetch(tab: unknown, url: string, opts?: SprinkleBrowserFetchOptions): Promise<unknown>;
}

export interface SprinkleExecFn {
  (cmd: string): Promise<SprinkleExecResult>;

  spawn(argv: string[]): Promise<SprinkleExecResult>;
}

export interface SprinkleHidInputReport {
  handle: string;
  reportId: number;
  data: Uint8Array;
}

export type SprinkleHidInputReportListener = (report: SprinkleHidInputReport) => void;

export type SprinkleUsbClaimEvent = UsbClaimEvent;
export type SprinkleUsbClaimListener = (event: SprinkleUsbClaimEvent) => void;

export interface SprinkleHidApi {
  list(): Promise<HidDeviceInfo[]>;
  request(filters?: HidDeviceFilter[]): Promise<HidDeviceInfo[]>;
  open(handle: string): Promise<void>;
  close(handle: string): Promise<void>;
  sendReport(handle: string, reportId: number, data: Uint8Array): Promise<void>;
  on(event: 'inputreport', cb: SprinkleHidInputReportListener): void;
  off(event: 'inputreport', cb: SprinkleHidInputReportListener): void;
}

export interface SprinkleSerialApi {
  list(): Promise<SerialDeviceInfo[]>;
  request(filters?: SerialFilter[]): Promise<SerialDeviceInfo>;
  open(handle: string, options: SerialOpenOptions): Promise<void>;
  close(handle: string): Promise<void>;
}

export interface SprinkleUsbApi {
  list(): Promise<UsbDeviceInfo[]>;
  request(filters?: UsbDeviceFilter[]): Promise<UsbDeviceInfo>;
  open(handle: string): Promise<void>;
  close(handle: string, opts?: { force?: boolean }): Promise<void>;
  reset(handle: string, opts?: { force?: boolean }): Promise<void>;
  selectConfiguration(handle: string, configurationValue: number): Promise<void>;
  claimInterface(handle: string, interfaceNumber: number, opts?: { wait?: boolean }): Promise<void>;
  releaseInterface(handle: string, interfaceNumber: number): Promise<void>;
  clearHalt(handle: string, direction: 'in' | 'out', endpointNumber: number): Promise<void>;
  controlTransferIn(
    handle: string,
    setup: UsbControlSetup,
    length: number
  ): Promise<{ status: string; bytes: Uint8Array }>;
  controlTransferOut(
    handle: string,
    setup: UsbControlSetup,
    bytes: Uint8Array
  ): Promise<{ status: string; bytesWritten: number }>;
  transferIn(
    handle: string,
    endpointNumber: number,
    length: number
  ): Promise<{ status: string; bytes: Uint8Array }>;
  transferOut(
    handle: string,
    endpointNumber: number,
    bytes: Uint8Array
  ): Promise<{ status: string; bytesWritten: number }>;
  on(event: 'disconnect' | 'claim-lost', cb: SprinkleUsbClaimListener): void;
  off(event: 'disconnect' | 'claim-lost', cb: SprinkleUsbClaimListener): void;
}

export const JSH_RESULT_PREFIX = '\u0001SLICCJSH\u0001';

function jshShellQuote(value: string): string {
  if (value.length === 0) return `''`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
    'var http=require("sliccy:http");' +
    'var c=http.client(a[0]||{});' +
    'var res=await c[a[1]](a[2],Object.assign({},a[3]||{},{raw:true}));' +
    'out={status:res.status,headers:res.headers,body:res.body};' +
    "}else if(op==='browser'){" +
    'var browser=require("sliccy:browser");' +
    'var m=a[0];if(typeof browser[m]!=="function")throw new Error("browser."+m+" is not available over the sprinkle bridge");' +
    'out=await browser[m].apply(browser,a.slice(1));' +
    "}else if(op==='spawn'){" +
    'out=await require("sliccy:exec").spawn(a[0]);' +
    "}else if(op==='fetchToFile'){" +
    'out=await require("node:fs").fetchToFile(a[0],a[1]);' +
    '}else{throw new Error("unknown jsh op: "+op);}' +
    'emit({ok:true,value:out});' +
    '}catch(e){emit({ok:false,error:(e&&e.message)?e.message:String(e)});}'
  );
}

export function buildJshNodeCommand(op: string, args: unknown[]): string {
  return `node -e ${jshShellQuote(buildJshNodeScript(op, args))}`;
}

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

export async function runJshOp(
  exec: (cmd: string) => Promise<SprinkleExecResult>,
  op: string,
  args: unknown[]
): Promise<unknown> {
  return parseJshResult(await exec(buildJshNodeCommand(op, args)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function u8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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

export function buildFetchResponse(v: SprinkleFetchResult): Response {
  const bin = atob(v.bodyBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const nullBody =
    v.status === 101 ||
    v.status === 103 ||
    v.status === 204 ||
    v.status === 205 ||
    v.status === 304;
  const body: BodyInit | null = nullBody ? null : bytes;
  const headers = new Headers(v.headers);
  try {
    const resp = new Response(body, { status: v.status, statusText: v.statusText, headers });
    Object.defineProperty(resp, 'url', { value: v.url, configurable: true });
    return resp;
  } catch {
    const resp = new Response(body, { headers });
    const ok = v.status >= 200 && v.status < 300;
    Object.defineProperty(resp, 'status', { value: v.status, configurable: true });
    Object.defineProperty(resp, 'statusText', { value: v.statusText, configurable: true });
    Object.defineProperty(resp, 'ok', { value: ok, configurable: true });
    Object.defineProperty(resp, 'url', { value: v.url, configurable: true });
    return resp;
  }
}

export function iframeFetchResponseSource(): string {
  return 'var buildFetchResponse = ' + buildFetchResponse.toString() + ';\n';
}

export type SprinkleExecHandler = (cmd: string) => Promise<SprinkleExecResult>;

export interface SprinkleLickRequest {
  action: string;
  data?: unknown;

  target?: string;
}

export interface SprinkleBridgeAPI {
  lick(event: SprinkleLickRequest | string): void;

  on(event: 'update', callback: (data: unknown) => void): void;

  off(event: 'update', callback: (data: unknown) => void): void;

  readFile(path: string): Promise<string>;

  writeFile(path: string, content: string): Promise<void>;

  readDir(path: string): Promise<Array<{ name: string; type: EntryType }>>;

  exists(path: string): Promise<boolean>;

  stat(path: string): Promise<{ type: EntryType; size: number }>;

  mkdir(path: string): Promise<void>;

  rm(path: string): Promise<void>;

  screenshot(selector?: string): Promise<string>;

  _container?: HTMLElement;

  setState(data: unknown): void;

  getState(): unknown;

  open(path: string, opts?: { projectRoot?: string }): void;

  close(): void;

  minimize(): void;

  stopCone(): void;

  attachImage(base64: string, name?: string, mimeType?: string): void;

  captureScreen(): Promise<CaptureScreenResult>;

  exec: SprinkleExecFn;

  agent(prompt: string, opts?: SprinkleAgentOptions): Promise<SprinkleAgentResult>;

  fetch(url: string, init?: SprinkleFetchInit): Promise<Response>;

  http: SprinkleHttp;

  browser: SprinkleBrowserApi;

  hid: SprinkleHidApi;

  serial: SprinkleSerialApi;

  usb: SprinkleUsbApi;

  readFileBinary(path: string): Promise<Uint8Array>;

  writeFileBinary(path: string, bytes: Uint8Array): Promise<void>;

  fetchToFile(url: string, path: string): Promise<number>;

  _jsh(op: string, args: unknown[]): Promise<unknown>;

  _device(channel: 'hid' | 'serial' | 'usb', op: string, args: unknown[]): Promise<unknown>;

  readonly name: string;
}

function shellQuote(value: string): string {
  if (value.length === 0) return `''`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type UpdateCallback = (data: unknown) => void;

export type SprinkleIframePusher = (
  sprinkleName: string,
  channel: string,
  payload: unknown
) => void;

export class SprinkleBridge {
  private listeners = new Map<string, Set<UpdateCallback>>();
  private lickHandler: (event: LickEvent, originUnitId?: string) => void;
  private fs: VirtualFS;
  private closeHandler: (name: string) => void;
  private minimizeHandler: (name: string) => void;
  private stopConeHandler: () => void;
  private attachImageHandler: (base64: string, name?: string, mimeType?: string) => void;
  private captureScreenHandler: () => Promise<CaptureScreenResult>;
  private execHandler: SprinkleExecHandler | undefined;

  private hidSubs = new Map<string, Map<string, () => void | Promise<void>>>();
  private iframePusher: SprinkleIframePusher | undefined;
  private usbClaimUnsub: (() => void) | null = null;
  private usbClaimRelayReady: Promise<void> | null = null;

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent, originUnitId?: string) => void,
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

  setIframePusher(pusher: SprinkleIframePusher | undefined): void {
    this.iframePusher = pusher;
  }

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

  private async usbOp(
    sprinkleName: string,
    op: string,
    args: readonly unknown[]
  ): Promise<unknown> {
    const reg = getSharedUsbRegistry();
    const owner = usbSprinkleOwner(sprinkleName);
    await this.ensureUsbClaimRelay();
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
        await usbOps.usbClose(reg, args[0] as string, {
          owner,
          force: Boolean((args[1] as { force?: boolean } | null | undefined)?.force),
        });
        return { ok: true };
      }
      case 'reset': {
        await usbOps.usbReset(reg, args[0] as string, {
          owner,
          force: Boolean((args[1] as { force?: boolean } | null | undefined)?.force),
        });
        return { ok: true };
      }
      case 'selectConfig': {
        await usbOps.usbSelectConfiguration(reg, args[0] as string, args[1] as number);
        return { ok: true };
      }
      case 'claim': {
        await usbOps.usbClaimInterface(reg, args[0] as string, args[1] as number, {
          owner,
          wait: Boolean((args[2] as { wait?: boolean } | null | undefined)?.wait),
        });
        return { ok: true };
      }
      case 'release': {
        await usbOps.usbReleaseInterface(reg, args[0] as string, args[1] as number, { owner });
        return { ok: true };
      }
      case 'clearHalt': {
        await usbOps.usbClearHalt(
          reg,
          args[0] as string,
          args[1] as 'in' | 'out',
          args[2] as number
        );
        return { ok: true };
      }
      case 'controlIn': {
        const r = await usbOps.usbControlTransferIn(
          reg,
          args[0] as string,
          args[1] as UsbControlSetup,
          args[2] as number
        );
        return { status: r.status, base64: u8ToBase64(new Uint8Array(r.bytes)) };
      }
      case 'controlOut': {
        const r = await usbOps.usbControlTransferOut(
          reg,
          args[0] as string,
          args[1] as UsbControlSetup,
          toArrayBuffer(base64ToU8(args[2] as string))
        );
        return { status: r.status, bytesWritten: r.bytesWritten };
      }
      case 'transferIn': {
        const r = await usbOps.usbTransferIn(
          reg,
          args[0] as string,
          args[1] as number,
          args[2] as number
        );
        return { status: r.status, base64: u8ToBase64(new Uint8Array(r.bytes)) };
      }
      case 'transferOut': {
        const r = await usbOps.usbTransferOut(
          reg,
          args[0] as string,
          args[1] as number,
          toArrayBuffer(base64ToU8(args[2] as string))
        );
        return { status: r.status, bytesWritten: r.bytesWritten };
      }
      default:
        throw new Error(`usb: unknown op '${op}'`);
    }
  }

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

  private async detachHidInputReports(sprinkleName: string, handle: string): Promise<void> {
    const map = this.hidSubs.get(sprinkleName);
    if (!map) return;
    const off = map.get(handle);
    if (off) {
      map.delete(handle);
      try {
        await Promise.resolve(off());
      } catch {}
    }
    if (map.size === 0) this.hidSubs.delete(sprinkleName);
  }

  private deliverHidInputReport(sprinkleName: string, report: SprinkleHidInputReport): void {
    const set = this.listeners.get(`${sprinkleName}:hid:inputreport`);
    if (set) {
      for (const cb of set) {
        const currentSet = set;
        setTimeout(() => {
          if (!currentSet.has(cb)) return;
          try {
            (cb as unknown as SprinkleHidInputReportListener)(report);
          } catch {}
        }, 0);
      }
    }
    try {
      this.iframePusher?.(sprinkleName, 'hid:inputreport', report);
    } catch {}
  }

  private ensureUsbClaimRelay(): Promise<void> {
    if (!this.usbClaimRelayReady) {
      this.usbClaimRelayReady = import('../kernel/usb-claim-broker.js').then((m) => {
        if (this.usbClaimUnsub) return;
        this.usbClaimUnsub = m.addClaimListener(getSharedUsbRegistry(), (event) => {
          this.deliverUsbClaimEvent(event);
        });
      });
    }
    return this.usbClaimRelayReady;
  }

  private deliverUsbClaimEvent(event: UsbClaimEvent): void {
    const holderSprinkle = parseUsbSprinkleOwner(event.holder);
    if (!holderSprinkle) return;
    const channel = `usb:${event.type}` as const;
    const set = this.listeners.get(`${holderSprinkle}:usb:${event.type}`);
    if (set) {
      for (const cb of set) {
        const currentSet = set;
        setTimeout(() => {
          if (!currentSet.has(cb)) return;
          try {
            (cb as unknown as SprinkleUsbClaimListener)(event);
          } catch {}
        }, 0);
      }
    }
    try {
      this.iframePusher?.(holderSprinkle, channel, event);
    } catch {}
  }

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
    return runJshOp((cmd) => this.runExec(cmd), op, args);
  }

  private createLickHandler(
    sprinkleName: string,
    getOriginUnitId: () => string | undefined
  ): (event: SprinkleLickRequest | string) => void {
    return (event) => {
      const action = typeof event === 'string' ? event : event.action;
      const data = typeof event === 'string' ? undefined : event.data;
      const targetScoop = typeof event === 'string' ? undefined : event.target;
      const lickEvent: LickEvent = {
        type: 'sprinkle',
        sprinkleName,
        targetScoop,
        timestamp: new Date().toISOString(),
        body: { action, data },
      };
      this.lickHandler(lickEvent, getOriginUnitId());
    };
  }

  private createScreenshotHandler(
    container: HTMLElement | undefined
  ): (selector?: string) => Promise<string> {
    return async (selector) => {
      if (!container) return '';
      return captureSprinkleScreenshot(selector, container);
    };
  }

  private createAgentHandler(): (
    prompt: string,
    opts?: SprinkleAgentOptions
  ) => Promise<SprinkleAgentResult> {
    return async (prompt, opts) => {
      const cwd = opts?.cwd ?? '.';
      const allowed = opts?.allowedCommands ?? '*';

      const parts = ['agent'];
      if (opts?.model) parts.push('--model', shellQuote(opts.model));
      if (opts?.thinking) parts.push('--thinking', shellQuote(opts.thinking));
      if (opts?.readOnly) parts.push('--read-only', shellQuote(opts.readOnly));
      parts.push(shellQuote(cwd), shellQuote(allowed), shellQuote(prompt));
      const result = await this.runExec(parts.join(' '));

      return { stdout: result.stdout || result.stderr, exitCode: result.exitCode };
    };
  }

  private createHidApi(sprinkleName: string): SprinkleHidApi {
    return {
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
    };
  }

  private createSerialApi(sprinkleName: string): SprinkleSerialApi {
    return {
      list: () => this.serialOp(sprinkleName, 'list', []) as Promise<SerialDeviceInfo[]>,
      request: (filters?: SerialFilter[]) =>
        this.serialOp(sprinkleName, 'request', [filters ?? []]) as Promise<SerialDeviceInfo>,
      open: async (handle: string, options: SerialOpenOptions) => {
        await this.serialOp(sprinkleName, 'open', [handle, options]);
      },
      close: async (handle: string) => {
        await this.serialOp(sprinkleName, 'close', [handle]);
      },
    };
  }

  private createUsbApi(sprinkleName: string): SprinkleUsbApi {
    return {
      list: () => this.usbOp(sprinkleName, 'list', []) as Promise<UsbDeviceInfo[]>,
      request: (filters?: UsbDeviceFilter[]) =>
        this.usbOp(sprinkleName, 'request', [filters ?? []]) as Promise<UsbDeviceInfo>,
      open: async (handle: string) => {
        await this.usbOp(sprinkleName, 'open', [handle]);
      },
      close: async (handle: string, opts?: { force?: boolean }) => {
        await this.usbOp(sprinkleName, 'close', [handle, opts ?? null]);
      },
      reset: async (handle: string, opts?: { force?: boolean }) => {
        await this.usbOp(sprinkleName, 'reset', [handle, opts ?? null]);
      },
      selectConfiguration: async (handle: string, configurationValue: number) => {
        await this.usbOp(sprinkleName, 'selectConfig', [handle, configurationValue]);
      },
      claimInterface: async (
        handle: string,
        interfaceNumber: number,
        opts?: { wait?: boolean }
      ) => {
        await this.usbOp(sprinkleName, 'claim', [handle, interfaceNumber, opts ?? null]);
      },
      releaseInterface: async (handle: string, interfaceNumber: number) => {
        await this.usbOp(sprinkleName, 'release', [handle, interfaceNumber]);
      },
      clearHalt: async (handle: string, direction: 'in' | 'out', endpointNumber: number) => {
        await this.usbOp(sprinkleName, 'clearHalt', [handle, direction, endpointNumber]);
      },
      controlTransferIn: async (handle: string, setup: UsbControlSetup, length: number) => {
        const r = (await this.usbOp(sprinkleName, 'controlIn', [handle, setup, length])) as {
          status: string;
          base64: string;
        };
        return { status: r.status, bytes: base64ToU8(r.base64) };
      },
      controlTransferOut: async (handle: string, setup: UsbControlSetup, bytes: Uint8Array) =>
        this.usbOp(sprinkleName, 'controlOut', [handle, setup, u8ToBase64(bytes)]) as Promise<{
          status: string;
          bytesWritten: number;
        }>,
      transferIn: async (handle: string, endpointNumber: number, length: number) => {
        const r = (await this.usbOp(sprinkleName, 'transferIn', [
          handle,
          endpointNumber,
          length,
        ])) as { status: string; base64: string };
        return { status: r.status, bytes: base64ToU8(r.base64) };
      },
      transferOut: async (handle: string, endpointNumber: number, bytes: Uint8Array) =>
        this.usbOp(sprinkleName, 'transferOut', [
          handle,
          endpointNumber,
          u8ToBase64(bytes),
        ]) as Promise<{ status: string; bytesWritten: number }>,
      on: (event: 'disconnect' | 'claim-lost', cb: SprinkleUsbClaimListener) => {
        void this.ensureUsbClaimRelay();
        const key = `${sprinkleName}:usb:${event}`;
        let set = this.listeners.get(key);
        if (!set) {
          set = new Set();
          this.listeners.set(key, set);
        }
        set.add(cb as unknown as UpdateCallback);
      },
      off: (event: 'disconnect' | 'claim-lost', cb: SprinkleUsbClaimListener) => {
        this.listeners.get(`${sprinkleName}:usb:${event}`)?.delete(cb as unknown as UpdateCallback);
      },
    };
  }

  private createHttpClient(config: SprinkleHttpClientConfig): SprinkleHttpClient {
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
  }

  createAPI(
    sprinkleName: string,
    getOriginUnitId: () => string | undefined = () => undefined
  ): SprinkleBridgeAPI {
    const api: SprinkleBridgeAPI = {
      name: sprinkleName,
      lick: this.createLickHandler(sprinkleName, getOriginUnitId),
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
      screenshot: (selector?: string) => {
        const handler = this.createScreenshotHandler(api._container);
        return handler(selector);
      },
      setState: (data: unknown) => {
        try {
          localStorage.setItem(`slicc-sprinkle-state:${sprinkleName}`, JSON.stringify(data));
        } catch {}
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
      fetch: async (url: string, init?: SprinkleFetchInit) =>
        buildFetchResponse(
          (await this.jshDispatch('fetch', [url, init ?? null])) as SprinkleFetchResult
        ),
      http: {
        client: (config: SprinkleHttpClientConfig) => this.createHttpClient(config),
      },
      browser: {
        findTab: (query) => this.jshDispatch('browser', ['findTab', query]),
        ensureTab: (url, options) => this.jshDispatch('browser', ['ensureTab', url, options ?? {}]),
        openWindow: (url, options) =>
          this.jshDispatch('browser', ['openWindow', url, options ?? {}]),
        windowBounds: (tab) => this.jshDispatch('browser', ['windowBounds', tab]),
        setWindowBounds: (tab, bounds) =>
          this.jshDispatch('browser', ['setWindowBounds', tab, bounds]),
        eval: (tab, code) => this.jshDispatch('browser', ['eval', tab, code]),
        evalAsync: (tab, code) => this.jshDispatch('browser', ['evalAsync', tab, code]),
        cookie: (tab, name) =>
          this.jshDispatch('browser', ['cookie', tab, name]) as Promise<string | null>,
        localStorage: (tab, key) =>
          this.jshDispatch('browser', ['localStorage', tab, key]) as Promise<string | null>,
        fetch: (tab, url, opts) => this.jshDispatch('browser', ['fetch', tab, url, opts ?? {}]),
      },
      hid: this.createHidApi(sprinkleName),
      serial: this.createSerialApi(sprinkleName),
      usb: this.createUsbApi(sprinkleName),
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
      agent: this.createAgentHandler(),
    };
    return api;
  }

  pushUpdate(sprinkleName: string, data: unknown): void {
    const key = `${sprinkleName}:update`;
    const set = this.listeners.get(key);
    if (set) {
      for (const cb of set) {
        const currentSet = set;
        setTimeout(() => {
          if (!currentSet.has(cb)) return;
          try {
            cb(data);
          } catch {}
        }, 0);
      }
    }
  }

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
        } catch {}
      }
      this.hidSubs.delete(sprinkleName);
    }
  }
}
