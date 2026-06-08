/**
 * `realm-host.ts` — kernel-side server for realm RPC. Wires the
 * realm's `realm-rpc-req` traffic into the calling
 * `CommandContext`'s `fs` / `exec` / `fetch`.
 *
 * Critical secret-injection invariant: the `fetch` channel proxies
 * through `ctx.fetch` (just-bash `SecureFetch`) when present, NOT
 * `globalThis.fetch`. CLI mode routes outbound requests through
 * `/api/fetch-proxy` so masked secret values get substituted
 * server-side; falling back to the worker / page's native `fetch`
 * sends the literal masked value upstream and breaks every secret-
 * gated API call. Pinned in `realm-rpc.test.ts`.
 */

import type { CommandContext } from 'just-bash';
import type { BrowserAPI } from '../../cdp/browser-api.js';
import {
  type HidBackend,
  resolveHidBackend,
} from '../../shell/supplemental-commands/hid-backends.js';
import { createNodeFetchAdapter } from '../../shell/supplemental-commands/node-fetch-adapter.js';
import {
  resolveSerialBackend,
  type SerialBackend,
} from '../../shell/supplemental-commands/serial-backends.js';
import {
  resolveUsbBackend,
  type UsbBackend,
} from '../../shell/supplemental-commands/usb-backends.js';
import type { HidDeviceFilter } from '../hid-device-registry.js';
import { getPanelRpcClient, hasLocalDom } from '../panel-rpc.js';
import type {
  SerialFilter,
  SerialOpenOptions,
  SerialOutputSignals,
} from '../serial-port-registry.js';
import type { UsbControlSetup, UsbDeviceFilter } from '../usb-device-registry.js';
import type { RealmPortLike } from './realm-rpc.js';
import type {
  RealmEventMsg,
  RealmRpcRequest,
  RealmRpcResponse,
  SerializedFetchResponse,
  TabHandle,
  WsObserveRequest,
  WsSelector,
  WsSubscriberInfo,
} from './realm-types.js';
import type { WsSubscriberRegistry } from './ws-subscribers.js';

export interface RealmHostHandle {
  /** Detach the message listener. Idempotent. */
  dispose(): void;
}

/**
 * Optional dependencies injected into the realm host. `browser` is
 * resolved via this hook for tests; production callers can omit it
 * and the host falls back to `globalThis.__slicc_browser` (the
 * BrowserAPI published by `kernel/host.ts` at boot).
 */
export interface RealmHostOptions {
  browser?: BrowserAPI;
  /**
   * Optional override for the WebSocket subscriber registry used by
   * `browser.websocket.*`. Production callers omit it and the host
   * falls back to `globalThis.__slicc_wsSubscribers` (constructed in
   * `kernel/host.ts`). Tests inject an in-memory registry directly.
   */
  wsSubscribers?: WsSubscriberRegistry;
  /**
   * Owning scoop's `jid`. Stamped onto every `wsObserve` so the
   * registry can auto-clean up subscribers on `scoop drop`. Realm
   * callers cannot supply this themselves — it must come from the
   * trusted host side.
   */
  scoopJid?: string;
  /**
   * Optional overrides for the WebUSB / Web Serial / WebHID backends
   * used by the `usb` / `serial` / `hid` channels. Production callers
   * omit them and the host resolves the same dual-path backend the
   * shell commands use (`resolve*Backend(hasLocalDom, getPanelRpcClient)`):
   * the local `navigator.*` in a DOM realm, the panel-RPC bridge in the
   * kernel worker. Tests inject in-memory backends directly.
   */
  usbBackend?: UsbBackend;
  serialBackend?: SerialBackend;
  hidBackend?: HidBackend;
}

/**
 * Attach an RPC server to a realm port. Returns a handle whose
 * `dispose()` removes the listener — the runner calls it when the
 * realm exits or is force-terminated so the port doesn't keep
 * answering after the realm is gone.
 */
export function attachRealmHost(
  port: RealmPortLike,
  ctx: CommandContext,
  opts: RealmHostOptions = {}
): RealmHostHandle {
  // Per-port HID `inputreport` subscriptions, keyed by device handle.
  // The realm side calls `hid.subscribeInputReports(h)` to start the
  // backend listener and `unsubscribeInputReports(h)` to stop it;
  // `dispose()` drains the map so realm teardown can never leak a
  // page-side `inputreport` listener (DOD: "no leaked subscriptions
  // on realm teardown").
  const hidSubscriptions = new Map<string, () => void | Promise<void>>();
  let disposed = false;
  const pushEvent = (msg: RealmEventMsg, transfer: Transferable[] = []): void => {
    if (disposed) return;
    try {
      port.postMessage(msg, transfer);
    } catch {
      // Disposed ports / detached transferables — best-effort, the
      // listener-cleanup happens via `dispose()`.
    }
  };
  const hidCtx: HidDispatchCtx = { subscriptions: hidSubscriptions, pushEvent };
  const handler = (event: MessageEvent): void => {
    const data = event.data as { type?: string };
    if (data?.type !== 'realm-rpc-req') return;
    const req = event.data as RealmRpcRequest;
    void respond(port, req, ctx, opts, hidCtx);
  };
  port.addEventListener('message', handler);
  port.start?.();
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      port.removeEventListener('message', handler);
      // Drain HID subscriptions best-effort; sync and async unsubscribes
      // are both honored. We don't await — `dispose()` is sync, and the
      // backend's unsubscribe surface accepts fire-and-forget here.
      for (const unsub of hidSubscriptions.values()) {
        try {
          void Promise.resolve(unsub()).catch(() => {});
        } catch {
          /* swallow — realm teardown must not throw */
        }
      }
      hidSubscriptions.clear();
    },
  };
}

async function respond(
  port: RealmPortLike,
  req: RealmRpcRequest,
  ctx: CommandContext,
  opts: RealmHostOptions,
  hidCtx: HidDispatchCtx
): Promise<void> {
  try {
    const result = await dispatch(req, ctx, opts, hidCtx);
    const res: RealmRpcResponse = { type: 'realm-rpc-res', id: req.id, result };
    // Body bytes need to be transferred so we don't structured-clone
    // potentially-large response bodies on every fetch.
    const transfer = collectTransferables(result);
    port.postMessage(res, transfer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const res: RealmRpcResponse = { type: 'realm-rpc-res', id: req.id, error: message };
    port.postMessage(res);
  }
}

async function dispatch(
  req: RealmRpcRequest,
  ctx: CommandContext,
  opts: RealmHostOptions,
  hidCtx: HidDispatchCtx
): Promise<unknown> {
  switch (req.channel) {
    case 'vfs':
      return dispatchVfs(req.op, req.args, ctx);
    case 'exec':
      return dispatchExec(req.op, req.args, ctx);
    case 'fetch':
      return dispatchFetch(req.op, req.args, ctx);
    case 'browser':
      return dispatchBrowser(req.op, req.args, resolveBrowser(opts), opts);
    case 'usb':
      return dispatchUsb(req.op, req.args, resolveUsbBackendForHost(opts));
    case 'serial':
      return dispatchSerial(req.op, req.args, resolveSerialBackendForHost(opts));
    case 'hid':
      return dispatchHid(req.op, req.args, resolveHidBackendForHost(opts), hidCtx);
    default:
      throw new Error(`realm-host: unknown channel '${req.channel}'`);
  }
}

/**
 * Resolve the BrowserAPI to use for the `browser` channel. Tests
 * inject one through `opts`; production paths read the one published
 * on `globalThis` by `kernel/host.ts`. A missing browser throws a
 * clear "unavailable in this runtime" error rather than a generic
 * undefined-method crash.
 */
function resolveBrowser(opts: RealmHostOptions): BrowserAPI {
  if (opts.browser) return opts.browser;
  const g = globalThis as { __slicc_browser?: BrowserAPI };
  if (g.__slicc_browser) return g.__slicc_browser;
  throw new Error('browser is not available in this runtime');
}

/**
 * Resolve the WS subscriber registry used by `browser.websocket.*`.
 * Production callers leave `opts.wsSubscribers` unset and the host
 * picks up the singleton wired in `kernel/host.ts`; tests inject one
 * directly. Missing registry throws a clear runtime error rather
 * than crashing with `undefined.observe is not a function`.
 */
function resolveWsSubscribers(opts: RealmHostOptions): WsSubscriberRegistry {
  if (opts.wsSubscribers) return opts.wsSubscribers;
  const g = globalThis as { __slicc_wsSubscribers?: WsSubscriberRegistry };
  if (g.__slicc_wsSubscribers) return g.__slicc_wsSubscribers;
  throw new Error('browser.websocket is not available in this runtime');
}

/**
 * Resolve the WebUSB / Web Serial / WebHID backend for the device
 * channels. Tests inject one through `opts`; production paths resolve
 * the same dual-path backend the shell commands use — the local
 * `navigator.*` in a DOM realm (extension), the panel-RPC bridge in the
 * kernel worker (standalone). A missing backend throws a clear
 * "unavailable in this runtime" error.
 */
function resolveUsbBackendForHost(opts: RealmHostOptions): UsbBackend {
  if (opts.usbBackend) return opts.usbBackend;
  const backend = resolveUsbBackend(hasLocalDom(), getPanelRpcClient());
  if (!backend) throw new Error('usb is not available in this runtime');
  return backend;
}

function resolveSerialBackendForHost(opts: RealmHostOptions): SerialBackend {
  if (opts.serialBackend) return opts.serialBackend;
  const backend = resolveSerialBackend(hasLocalDom(), getPanelRpcClient());
  if (!backend) throw new Error('serial is not available in this runtime');
  return backend;
}

function resolveHidBackendForHost(opts: RealmHostOptions): HidBackend {
  if (opts.hidBackend) return opts.hidBackend;
  const backend = resolveHidBackend(hasLocalDom(), getPanelRpcClient());
  if (!backend) throw new Error('hid is not available in this runtime');
  return backend;
}

// ---------------------------------------------------------------------------
// Channel: vfs
// ---------------------------------------------------------------------------

async function dispatchVfs(op: string, args: unknown[], ctx: CommandContext): Promise<unknown> {
  const path = typeof args[0] === 'string' ? (args[0] as string) : null;
  const resolved = path !== null ? ctx.fs.resolvePath(ctx.cwd, path) : null;
  switch (op) {
    case 'readFile':
      return ctx.fs.readFile(resolved!);
    case 'readFileBinary':
      return ctx.fs.readFileBuffer(resolved!);
    case 'writeFile':
      await ctx.fs.writeFile(resolved!, args[1] as string);
      return true;
    case 'writeFileBinary':
      await ctx.fs.writeFile(resolved!, args[1] as Uint8Array);
      return true;
    case 'readDir':
      return ctx.fs.readdir(resolved!);
    case 'exists':
      return ctx.fs.exists(resolved!);
    case 'stat': {
      const st = await ctx.fs.stat(resolved!);
      return { isDirectory: st.isDirectory, isFile: st.isFile, size: st.size };
    }
    case 'mkdir':
      await ctx.fs.mkdir(resolved!, { recursive: true });
      return true;
    case 'rm':
      await ctx.fs.rm(resolved!, { recursive: true });
      return true;
    case 'resolvePath':
      return ctx.fs.resolvePath(ctx.cwd, args[0] as string);
    default:
      throw new Error(`realm-host: unknown vfs op '${op}'`);
  }
}

// ---------------------------------------------------------------------------
// Channel: exec
// ---------------------------------------------------------------------------

async function dispatchExec(op: string, args: unknown[], ctx: CommandContext): Promise<unknown> {
  if (!ctx.exec) throw new Error('exec is not available in this runtime');
  if (op === 'run') {
    const command = args[0] as string;
    const result = await ctx.exec(command, { cwd: ctx.cwd });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }
  if (op === 'spawn') {
    // Shell-free variant — mirrors `child_process.spawnSync(cmd, args)`.
    // Passes `argv.slice(1)` through just-bash's `args` option, which
    // bypasses shell parsing / globbing / quoting entirely. argv[0] is
    // the bare executable name (no metas) so the shell sees a single
    // word and the rest are appended verbatim. Eliminates the
    // `shellQuote()` boilerplate skills used to keep around.
    const argv = args[0];
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
      throw new Error('exec.spawn: argv must be a non-empty string[]');
    }
    const [cmd, ...rest] = argv as string[];
    const result = await ctx.exec(cmd, { cwd: ctx.cwd, args: rest });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }
  throw new Error(`realm-host: unknown exec op '${op}'`);
}

// ---------------------------------------------------------------------------
// Channel: fetch
// ---------------------------------------------------------------------------

async function dispatchFetch(
  op: string,
  args: unknown[],
  ctx: CommandContext
): Promise<SerializedFetchResponse> {
  if (op !== 'request') throw new Error(`realm-host: unknown fetch op '${op}'`);
  const [url, init] = args as [string, RequestInit | undefined];
  // Prefer ctx.fetch (SecureFetch) — keeps secret substitution and
  // domain allow-listing on the host side. Without this, kernel-
  // realm scripts would bypass the proxy and break every
  // secret-gated API.
  const fetchFn: typeof globalThis.fetch = ctx.fetch
    ? createNodeFetchAdapter(ctx.fetch)
    : globalThis.fetch.bind(globalThis);
  const response = await fetchFn(url, init);
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    url: response.url,
  };
}

// ---------------------------------------------------------------------------
// Channel: browser
// ---------------------------------------------------------------------------

/**
 * Dispatch a `browser` channel RPC. All ops route through
 * `BrowserAPI` (the same surface `playwright-command.ts` uses), so
 * standalone and extension floats share one bridge — only the
 * underlying CDP transport differs. Tab-scoped ops serialize through
 * `browser.withTab` so they can't race with the panel terminal's
 * `playwright` invocations.
 */
async function dispatchBrowser(
  op: string,
  args: unknown[],
  browser: BrowserAPI,
  opts: RealmHostOptions
): Promise<unknown> {
  switch (op) {
    case 'findTab': {
      const query = (args[0] as { domain?: string; urlMatch?: string } | undefined) ?? {};
      return findTab(browser, query);
    }
    case 'ensureTab': {
      const url = args[0] as string;
      const options = (args[1] as { matchUrl?: string } | undefined) ?? {};
      return ensureTab(browser, url, options);
    }
    case 'eval': {
      const targetId = args[0] as string;
      const code = args[1] as string;
      return evalInTab(browser, targetId, code, false);
    }
    case 'evalAsync': {
      const targetId = args[0] as string;
      const code = args[1] as string;
      return evalInTab(browser, targetId, code, true);
    }
    case 'cookie': {
      const targetId = args[0] as string;
      const name = args[1] as string;
      return getCookie(browser, targetId, name);
    }
    case 'localStorage': {
      const targetId = args[0] as string;
      const key = args[1] as string;
      return getLocalStorage(browser, targetId, key);
    }
    case 'wsObserve': {
      // Realm code never supplies the owning scoop — the trusted host
      // side stamps it from `opts.scoopJid` so the registry's
      // `dropForScoop(jid)` cleanup hook can find this entry later.
      const req = { ...(args[0] as WsObserveRequest), scoopJid: opts.scoopJid };
      const info: WsSubscriberInfo = await resolveWsSubscribers(opts).observe(req);
      return info;
    }
    case 'wsUpdate': {
      const id = args[0] as string;
      const patch =
        (args[1] as { urlMatch?: string | null; filter?: WsSelector | null } | undefined) ?? {};
      return resolveWsSubscribers(opts).update(id, patch);
    }
    case 'wsClose': {
      const id = args[0] as string;
      return resolveWsSubscribers(opts).close(id);
    }
    case 'wsList': {
      return resolveWsSubscribers(opts).list();
    }
    default:
      throw new Error(`realm-host: unknown browser op '${op}'`);
  }
}

async function listTabHandles(browser: BrowserAPI): Promise<TabHandle[]> {
  // `listAllTargets` includes remote tray targets when wired; the
  // standalone path with no tray transparently falls back to
  // `listPages`.
  const pages =
    typeof browser.listAllTargets === 'function'
      ? await browser.listAllTargets()
      : await browser.listPages();
  return pages.map((p) => ({ targetId: p.targetId, url: p.url, title: p.title }));
}

async function findTab(
  browser: BrowserAPI,
  query: { domain?: string; urlMatch?: string }
): Promise<TabHandle | null> {
  const tabs = await listTabHandles(browser);
  if (query.domain) {
    const wanted = query.domain.toLowerCase();
    for (const t of tabs) {
      const host = safeHostname(t.url);
      if (host && host.toLowerCase() === wanted) return t;
    }
    return null;
  }
  if (query.urlMatch) {
    let re: RegExp;
    try {
      re = new RegExp(query.urlMatch);
    } catch (err) {
      throw new Error(
        `browser.findTab: invalid urlMatch regex: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    for (const t of tabs) {
      if (re.test(t.url)) return t;
    }
    return null;
  }
  throw new Error('browser.findTab: query requires `domain` or `urlMatch`');
}

async function ensureTab(
  browser: BrowserAPI,
  url: string,
  options: { matchUrl?: string }
): Promise<TabHandle> {
  // Default match: same origin as the requested URL. Callers can
  // override with a regex (`matchUrl`) when origin equality is too
  // loose / tight (e.g. matching a path prefix or a tray target).
  const tabs = await listTabHandles(browser);
  if (options.matchUrl) {
    let re: RegExp;
    try {
      re = new RegExp(options.matchUrl);
    } catch (err) {
      throw new Error(
        `browser.ensureTab: invalid matchUrl regex: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const hit = tabs.find((t) => re.test(t.url));
    if (hit) return hit;
  } else {
    const wantedOrigin = safeOrigin(url);
    if (wantedOrigin) {
      const hit = tabs.find((t) => safeOrigin(t.url) === wantedOrigin);
      if (hit) return hit;
    }
  }
  const targetId = await browser.createPage(url);
  // `createPage` returns just the id; build a handle eagerly so the
  // caller can immediately `browser.eval(tab, ...)` without a second
  // listPages round-trip. Title may still be empty (the page hasn't
  // loaded yet) but `url` matches what the caller asked for.
  return { targetId, url, title: '' };
}

async function evalInTab(
  browser: BrowserAPI,
  targetId: string,
  code: string,
  awaitPromise: boolean
): Promise<unknown> {
  return browser.withTab(targetId, async () => {
    const value = await browser.evaluate(code, { awaitPromise, returnByValue: true });
    return unwrapEvalResult(value);
  });
}

/**
 * Transparent double-JSON unwrap. CDP `Runtime.evaluate` with
 * `returnByValue: true` already round-trips structured-cloneable
 * values directly — but the long-standing convention in
 * `playwright eval-file` scripts is to `JSON.stringify` the final
 * value so the shell can pipe it cleanly. That puts one or two
 * layers of JSON encoding between the user's value and the realm
 * caller. We peel only the layers we can prove are wrappers:
 *
 *  - If the first parse yields an object/array, the original
 *    string can only have been `JSON.stringify(obj)` — return it.
 *  - If the first parse yields a string AND that inner string
 *    itself starts with `{` or `[`, the original was a double
 *    `JSON.stringify` — peel one more layer.
 *  - Otherwise (primitive parses such as `"123"`, `"true"`,
 *    `"null"`, `"-1.5"`, or a `JSON.stringify("hello")` →
 *    `"\"hello\""` round-trip), leave the original string alone or
 *    return the single-unwrapped inner string. Primitives that the
 *    page returned as strings must keep their string type — losing
 *    that distinction would silently turn `localStorage.getItem`
 *    values into numbers/booleans.
 */
function unwrapEvalResult(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const first = tryParseJson(value);
  if (first === undefined) return value;
  if (first !== null && typeof first === 'object') return first;
  if (typeof first === 'string') {
    // First layer was a stringified string. Only unwrap a second
    // time when the inner string is itself a stringified
    // object/array — that's the only shape we can be sure was a
    // double wrap rather than a deliberate single `JSON.stringify`
    // of a plain string.
    const trimmed = first.trim();
    if (trimmed.length > 0 && (trimmed[0] === '{' || trimmed[0] === '[')) {
      const second = tryParseJson(first);
      if (second !== null && typeof second === 'object') return second;
    }
    return first;
  }
  // Primitive (number / boolean / null) — keep the caller's original
  // string so a page value of `"123"` doesn't become `123`.
  return value;
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  // Cheap heuristic gate: only parse strings that look like a JSON
  // literal. The check is intentionally permissive (we still need
  // to recognize stringified objects, arrays, and strings) — the
  // result-type discrimination in `unwrapEvalResult` is what
  // protects primitive payloads from getting unwrapped.
  if (trimmed.length === 0) return undefined;
  const first = trimmed[0];
  const looksJson =
    first === '{' ||
    first === '[' ||
    first === '"' ||
    first === '-' ||
    (first >= '0' && first <= '9') ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null';
  if (!looksJson) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

async function getCookie(
  browser: BrowserAPI,
  targetId: string,
  name: string
): Promise<string | null> {
  return browser.withTab(targetId, async () => {
    // `Network.getCookies` (no `urls`) returns cookies visible to
    // the attached page — same surface `playwright cookie-get`
    // uses, so standalone + extension behave identically.
    const result = await browser.sendCDP('Network.getCookies');
    const cookies = (result['cookies'] as Array<{ name?: string; value?: string }>) ?? [];
    const hit = cookies.find((c) => c.name === name);
    return hit && typeof hit.value === 'string' ? hit.value : null;
  });
}

async function getLocalStorage(
  browser: BrowserAPI,
  targetId: string,
  key: string
): Promise<string | null> {
  // Read via in-page evaluate so we hit the same origin's storage
  // partition the page sees — `DOMStorage.getDOMStorageItems`
  // requires a frame ID and security origin lookup we'd otherwise
  // have to plumb, and the evaluate path matches `playwright
  // eval` semantics.
  return browser.withTab(targetId, async () => {
    const raw = await browser.evaluate(
      `(function(){try{var v=window.localStorage.getItem(${JSON.stringify(key)});return v===null?null:String(v);}catch(e){return null;}})()`,
      { returnByValue: true }
    );
    if (raw === null || raw === undefined) return null;
    return typeof raw === 'string' ? raw : String(raw);
  });
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Channels: usb / serial / hid
// ---------------------------------------------------------------------------

/**
 * Dispatch a `usb` channel RPC against the resolved backend. Op names
 * match the realm-side device-method semantics; binary results (`bytes`)
 * are handed back to the realm verbatim and transferred by
 * `collectTransferables`. The realm bridge re-wraps them as `DataView`s.
 */
async function dispatchUsb(op: string, args: unknown[], backend: UsbBackend): Promise<unknown> {
  switch (op) {
    case 'list':
      return backend.list();
    case 'request':
      return backend.request((args[0] as UsbDeviceFilter[]) ?? []);
    case 'info':
      return backend.info(args[0] as string);
    case 'open':
      return backend.open(args[0] as string);
    case 'close':
      return backend.close(args[0] as string);
    case 'reset':
      return backend.reset(args[0] as string);
    case 'selectConfig':
      return backend.selectConfig(args[0] as string, args[1] as number);
    case 'claim':
      return backend.claim(args[0] as string, args[1] as number);
    case 'release':
      return backend.release(args[0] as string, args[1] as number);
    case 'controlIn':
      return backend.controlIn(args[0] as string, args[1] as UsbControlSetup, args[2] as number);
    case 'controlOut':
      return backend.controlOut(
        args[0] as string,
        args[1] as UsbControlSetup,
        args[2] as Uint8Array
      );
    case 'transferIn':
      return backend.transferIn(args[0] as string, args[1] as number, args[2] as number);
    case 'transferOut':
      return backend.transferOut(args[0] as string, args[1] as number, args[2] as Uint8Array);
    default:
      throw new Error(`realm-host: unknown usb op '${op}'`);
  }
}

/** Dispatch a `serial` channel RPC against the resolved backend. */
async function dispatchSerial(
  op: string,
  args: unknown[],
  backend: SerialBackend
): Promise<unknown> {
  switch (op) {
    case 'list':
      return backend.list();
    case 'request':
      return backend.request((args[0] as SerialFilter[]) ?? []);
    case 'info':
      return backend.info(args[0] as string);
    case 'open':
      return backend.open(args[0] as string, args[1] as SerialOpenOptions);
    case 'close':
      return backend.close(args[0] as string);
    case 'read': {
      const params =
        (args[1] as { maxBytes?: number; until?: Uint8Array; timeoutMs?: number } | undefined) ??
        {};
      return backend.read(args[0] as string, params);
    }
    case 'write':
      return backend.write(args[0] as string, args[1] as Uint8Array);
    case 'getSignals':
      return backend.getSignals(args[0] as string);
    case 'setSignals':
      return backend.setSignals(args[0] as string, args[1] as SerialOutputSignals);
    default:
      throw new Error(`realm-host: unknown serial op '${op}'`);
  }
}

/**
 * Per-port state the HID dispatch needs beyond the backend itself:
 * the subscription map (so subscribe/unsubscribe are idempotent and
 * realm teardown can drain leftovers) and the push hook (so backend
 * `inputreport` callbacks fan back to the realm over the same port
 * the RPC arrived on). Lives in `attachRealmHost`'s closure.
 */
interface HidDispatchCtx {
  subscriptions: Map<string, () => void | Promise<void>>;
  pushEvent(msg: RealmEventMsg, transfer?: Transferable[]): void;
}

/** Dispatch a `hid` channel RPC against the resolved backend. */
async function dispatchHid(
  op: string,
  args: unknown[],
  backend: HidBackend,
  hidCtx: HidDispatchCtx
): Promise<unknown> {
  switch (op) {
    case 'list':
      return backend.list();
    case 'request':
      return backend.request((args[0] as HidDeviceFilter[]) ?? []);
    case 'info':
      return backend.info(args[0] as string);
    case 'open':
      return backend.open(args[0] as string);
    case 'close':
      return backend.close(args[0] as string);
    case 'sendReport':
      return backend.sendReport(args[0] as string, args[1] as number, args[2] as Uint8Array);
    case 'sendFeatureReport':
      return backend.sendFeatureReport(args[0] as string, args[1] as number, args[2] as Uint8Array);
    case 'receiveFeatureReport':
      return backend.receiveFeatureReport(args[0] as string, args[1] as number);
    case 'subscribeInputReports': {
      // Idempotent: a second subscribe for the same handle is a no-op so
      // a realm caller that hangs multiple listeners on one device only
      // opens one backend subscription. The matching unsubscribe runs on
      // `unsubscribeInputReports` or on realm-host `dispose()`.
      const handle = args[0] as string;
      if (hidCtx.subscriptions.has(handle)) return true;
      const off = await backend.subscribeInputReports(handle, (report) => {
        const bytes =
          report.bytes instanceof Uint8Array ? report.bytes : new Uint8Array(report.bytes);
        const msg: RealmEventMsg = {
          type: 'realm-event',
          channel: 'hid-input-report',
          payload: { handle, reportId: report.reportId, bytes },
        };
        hidCtx.pushEvent(msg, [bytes.buffer as Transferable]);
      });
      hidCtx.subscriptions.set(handle, off);
      return true;
    }
    case 'unsubscribeInputReports': {
      const handle = args[0] as string;
      const off = hidCtx.subscriptions.get(handle);
      if (!off) return true;
      hidCtx.subscriptions.delete(handle);
      await off();
      return true;
    }
    default:
      throw new Error(`realm-host: unknown hid op '${op}'`);
  }
}

// ---------------------------------------------------------------------------
// Transferables
// ---------------------------------------------------------------------------

/**
 * Collect transferable buffers from a result tree. Walks `Uint8Array` /
 * `ArrayBuffer` at the top level (e.g. `serial read`) and inside the
 * `body` (`SerializedFetchResponse`) / `bytes` (USB/HID in-transfers)
 * fields — the only places we hand back binary data today.
 */
function collectTransferables(result: unknown): Transferable[] {
  if (result instanceof Uint8Array) {
    return [result.buffer as Transferable];
  }
  if (result && typeof result === 'object') {
    const obj = result as { body?: unknown; bytes?: unknown };
    if (obj.body instanceof Uint8Array) {
      return [obj.body.buffer as Transferable];
    }
    if (obj.bytes instanceof Uint8Array) {
      return [obj.bytes.buffer as Transferable];
    }
  }
  return [];
}
