/**
 * B24-4: CDP shield for the extension bridge. A TypeScript port of
 * slicc-cdp's `crates/cdp-client/src/shield.rs` + the guard parts of `cdp.rs`,
 * scoped to chrome.debugger's one-session-per-tab model.
 *
 * The shield sits between the leader's `cdp.request`s and
 * `chrome.debugger.sendCommand`, and between `chrome.debugger.onEvent` and the
 * leader's `cdp.event`s. Pre-commit protection is a backend-owned
 * `Fetch.enable { urlPattern: '*', resourceType: 'Document', requestStage:
 * 'Request' }`: every document request (main frame, iframe, popup-free
 * redirect hop) pauses in the SW first, and a protected one is FAILED with
 * `BlockedByClient` so it never commits, so a client's init script never runs
 * on seven's origin or the vault. Client `Fetch.enable` patterns are merged
 * into the backend pattern; pauses the client did not ask for, and every
 * pause for a protected URL, are answered here and never reach the client.
 *
 * Pure helpers (cookie / storage / mention checks, redaction) mirror the Rust
 * names so the two shields can be diffed side by side.
 */

import type { CDPPayload } from '@slicc/shared-ts';
import { isProtectedTarget, isProtectedUrl, PROTECTED_RULES } from './protected-origins.js';

/** Keys whose string value names an origin (mirrors shield.rs ORIGIN_KEYS). */
const ORIGIN_KEYS = new Set([
  'origin',
  'securityOrigin',
  'ownerOrigin',
  'issuerOrigin',
  'topLevelOrigin',
  'topLevelSite',
  'embeddedOrigin',
  'requestingOrigin',
  'scopeURL',
  'manifestId',
]);

/** Free-form keys: page-controlled text, never parsed for origins. */
const FREE_FORM = new Set([
  'expression',
  'arguments',
  'value',
  'headers',
  'postData',
  'functionDeclaration',
  'source',
  'text',
  'body',
  'data',
  'message',
]);

const BODY_METHODS = new Set([
  'Network.getResponseBody',
  'Network.searchInResponseBody',
  'Network.streamResourceContent',
  'Network.getResponseBodyForInterception',
  'Network.takeResponseBodyForInterceptionAsStream',
  'Network.getRequestPostData',
  'Network.replayXHR',
  'Fetch.getResponseBody',
  'Fetch.takeResponseBodyAsStream',
  'Audits.getEncodedResponse',
]);

const COOKIE_SETTERS = new Set([
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Storage.setCookies',
  'Page.deleteCookie',
]);

const COOKIE_READERS = new Set([
  'Network.getCookies',
  'Network.getAllCookies',
  'Storage.getCookies',
  'Page.getCookies',
]);

/** Fetch commands that answer a paused request; the id must be one we forwarded. */
const FETCH_ANSWERS = new Set([
  'Fetch.continueRequest',
  'Fetch.fulfillRequest',
  'Fetch.failRequest',
  'Fetch.continueResponse',
  'Fetch.continueWithAuth',
  'Fetch.getResponseBody',
  'Fetch.takeResponseBodyAsStream',
]);

/** Methods refused outright: they reach past the tab to the whole browser. */
const REFUSED_METHODS = new Map<string, string>([
  [
    'Target.exposeDevToolsProtocol',
    'Target.exposeDevToolsProtocol would give a page the whole browser',
  ],
  [
    'Target.sendMessageToTarget',
    'Target.sendMessageToTarget is refused: attach with flatten: true instead',
  ],
  [
    'Target.attachToBrowserTarget',
    'Target.attachToBrowserTarget would give a page the whole browser',
  ],
  ['Tracing.start', "Tracing.start records every target, seven's included"],
  ['Extensions.loadUnpacked', "Extensions.loadUnpacked can reach seven's origin"],
  ['Network.clearBrowserCookies', "Network.clearBrowserCookies would clear seven's cookies"],
  ['Storage.clearCookies', "Storage.clearCookies would clear seven's cookies"],
  ['Browser.resetPermissions', "Browser.resetPermissions would reset seven's permissions"],
  [
    'Security.setIgnoreCertificateErrors',
    "ignoring certificate errors would let a forged seven's origin load",
  ],
  [
    'Security.setOverrideCertificateErrors',
    "overriding certificate errors would let a forged seven's origin load",
  ],
]);

export const COOKIES_REFUSAL = "slicc: refused: cookie is on seven's origin";
const UNSEEN_REFUSAL = 'slicc: refused: request was not seen by the shield';
const STREAM_REFUSAL = 'slicc: refused: stream handle was not opened through the shield';
const PAUSE_REFUSAL = 'slicc: refused: request was not paused toward this client';

/** The backend-owned Fetch pattern: every document, before it is sent. */
export const GUARD_FETCH_PATTERN: CDPPayload = {
  urlPattern: '*',
  resourceType: 'Document',
  requestStage: 'Request',
};

function isObj(value: unknown): value is CDPPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function refuse(reason: string): never {
  throw new Error(reason.startsWith('slicc: refused: ') ? reason : `slicc: refused: ${reason}`);
}

/** `ws(s)://` → `http(s)://` so a WebSocket to seven is judged like HTTP. */
export function webSocketAsHttp(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith('wss:')) return `https:${url.slice(4)}`;
  if (lower.startsWith('ws:')) return `http:${url.slice(3)}`;
  return url;
}

export function urlProtected(text: string): boolean {
  return isProtectedUrl(text) || isProtectedUrl(webSocketAsHttp(text));
}

/** True when any string anywhere in `value` is a protected URL. */
export function mentions(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(':') && urlProtected(value);
  if (Array.isArray(value)) return value.some(mentions);
  if (isObj(value)) return Object.values(value).some(mentions);
  return false;
}

/** The first `^`-part and every `^0`-prefixed part of a storage key. */
function storageKeyProtected(key: string): boolean {
  const [first, ...rest] = key.split('^');
  return [first, ...rest.filter((p) => p.startsWith('0')).map((p) => p.slice(1))].some(
    urlProtected
  );
}

function storageEntryProtected(key: string, item: unknown): boolean {
  if (FREE_FORM.has(key)) return false;
  if (typeof item !== 'string') return namesProtectedStorage(item);
  if (ORIGIN_KEYS.has(key) && urlProtected(item)) return true;
  if (key === 'storageKey') return storageKeyProtected(item);
  if (key === 'cacheId') return storageKeyProtected(item.split('|')[0] ?? '');
  return false;
}

/** True when params name seven's storage, origin or permissions outside free-form text. */
export function namesProtectedStorage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(namesProtectedStorage);
  if (!isObj(value)) return false;
  return Object.entries(value).some(([key, item]) => storageEntryProtected(key, item));
}

function hostOf(text: string): string | undefined {
  try {
    return new URL(text).hostname || undefined;
  } catch {
    return undefined;
  }
}

function cookieDomainProtected(domain: string): boolean {
  let d = domain.toLowerCase();
  if (d.startsWith('.')) d = d.slice(1);
  if (d.endsWith('.')) d = d.slice(0, -1);
  if (d === '') return false;
  const under = (host: string, parent: string): boolean =>
    host === parent || host.endsWith(`.${parent}`);
  if (PROTECTED_RULES.domains.some((x) => under(d, x))) return true;
  return [...PROTECTED_RULES.domains, ...PROTECTED_RULES.hosts].some((h) => under(h, d));
}

function siteProtected(site: string): boolean {
  if (urlProtected(site)) return true;
  const host = hostOf(site);
  return host !== undefined && cookieDomainProtected(host);
}

function cookieProtected(cookie: unknown): boolean {
  if (!isObj(cookie)) return false;
  const domain = str(cookie['domain']);
  if (domain && cookieDomainProtected(domain)) return true;
  const url = str(cookie['url']);
  if (url && siteProtected(url)) return true;
  const partition = cookie['partitionKey'];
  if (typeof partition === 'string') return siteProtected(partition);
  const top = isObj(partition) ? str(partition['topLevelSite']) : undefined;
  return top !== undefined && siteProtected(top);
}

/** True when a cookie setter (single cookie or `cookies[]`) touches seven. */
export function cookieRefused(params: CDPPayload): boolean {
  const cookies = params['cookies'];
  if (Array.isArray(cookies)) return cookies.some(cookieProtected);
  return cookieProtected(params);
}

/** Remove seven's cookies from a cookie reader's result, in place. */
export function dropProtectedCookies(result: CDPPayload): void {
  const cookies = result['cookies'];
  if (Array.isArray(cookies)) result['cookies'] = cookies.filter((c) => !cookieProtected(c));
}

function stripProtectedAssociated(params: CDPPayload): void {
  const cookies = params['associatedCookies'];
  if (!Array.isArray(cookies)) return;
  params['associatedCookies'] = cookies.filter(
    (item) => !(isObj(item) && cookieProtected(item['cookie']))
  );
}

/** Keep only the origin of a protected target's url and title. */
export function redacted(info: CDPPayload): CDPPayload {
  let origin = 'about:blank';
  try {
    const parsed = new URL(str(info['url']) ?? '');
    if (parsed.origin !== 'null') origin = parsed.origin;
  } catch {
    /* unparsable → about:blank */
  }
  return { ...info, url: origin, title: origin };
}

/** URL a network / fetch event or command is about. */
export function requestUrl(params: CDPPayload): string | undefined {
  const request = params['request'];
  const response = params['response'];
  return (
    (isObj(request) ? str(request['url']) : undefined) ??
    (isObj(response) ? str(response['url']) : undefined) ??
    str(params['url'])
  );
}

function requestKey(params: CDPPayload | undefined): string | undefined {
  return str(params?.['requestId']) ?? str(params?.['interceptionId']);
}

/**
 * JS statement prepended to every `Page.addScriptToEvaluateOnNewDocument`
 * source: it throws (aborting the rest of the script) when the new document's
 * origin is protected. Defense in depth behind the Fetch block: covers
 * documents that never touch the network (bfcache, inherited about:blank).
 */
export function initScriptGuard(): string {
  const rules = JSON.stringify({
    s: PROTECTED_RULES.schemes,
    h: PROTECTED_RULES.hosts,
    d: PROTECTED_RULES.domains,
  });
  const refusal = JSON.stringify(PROTECTED_RULES.refusal);
  return (
    `if((function(r,o){try{var u=new URL(o),h=u.hostname.toLowerCase().replace(/\\.$/,''),` +
    `s=u.protocol.slice(0,-1);return r.s.indexOf(s)>=0&&(r.h.indexOf(h)>=0||r.d.some(function(d){` +
    `return h===d||h.slice(-d.length-1)==='.'+d}))}catch(e){return false}})(${rules},self.origin))` +
    `throw new Error(${refusal});\n`
  );
}

/** CDP `RequestPattern` wildcard match (`*`, `?`, `\` escape). */
function wildcard(pattern: string, text: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] ?? '';
    if (c === '\\' && i + 1 < pattern.length) {
      i += 1;
      re += (pattern[i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's').test(text);
}

/** True when a client `RequestPattern` would have paused this request. */
export function patternMatches(pattern: unknown, paused: CDPPayload): boolean {
  if (!isObj(pattern)) return false;
  const stage =
    'responseStatusCode' in paused || 'responseErrorReason' in paused ? 'Response' : 'Request';
  if ((str(pattern['requestStage']) ?? 'Request') !== stage) return false;
  const type = str(pattern['resourceType']);
  if (type !== undefined && type !== str(paused['resourceType'])) return false;
  return wildcard(str(pattern['urlPattern']) ?? '*', requestUrl(paused) ?? '');
}

/** Bounded string→value map: forgets the oldest entries past `limit`. */
class Bounded<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly limit: number) {}
  get(key: string): V | undefined {
    return this.map.get(key);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  delete(key: string): V | undefined {
    const value = this.map.get(key);
    this.map.delete(key);
    return value;
  }
}

/** One debugger event, as forwarded to the client. */
export interface ShieldEvent {
  method: string;
  params?: CDPPayload;
}

type Send = (method: string, params?: CDPPayload) => Promise<CDPPayload>;

/** Client-requested Fetch interception for the tab (shared debugger session). */
interface ClientFetch {
  patterns: unknown[];
  handleAuthRequests: boolean;
}

/**
 * Per-tab shield state. One instance per chrome.debugger attachment; every
 * bridge Port that shares the tab shares it, and every debugger event for the
 * tab passes through {@link TabShield.onEvent} exactly once.
 */
export class TabShield {
  /** requestId (fetch or network) → whether it reaches or comes from seven. */
  private readonly requests = new Bounded<boolean>(5000);
  /** ExtraInfo events held until their request is known to be unprotected. */
  private readonly held = new Bounded<ShieldEvent[]>(500);
  /** frameId → urls/origins it committed. */
  private readonly frames = new Bounded<string[]>(1000);
  /** Fetch pause ids forwarded to the client — the only ones it may answer. */
  private readonly forwarded = new Bounded<true>(2000);
  private readonly streams = new Bounded<true>(500);
  /** Document URLs this shield failed before commit (the tab shows an error page for them). */
  private readonly failedDocuments = new Bounded<true>(200);
  private clientFetch: ClientFetch | null = null;
  private blockedFlag = false;

  constructor(
    private readonly send: Send,
    private readonly onBlocked: () => void
  ) {}

  get blocked(): boolean {
    return this.blockedFlag;
  }

  /** Arm the pre-commit guard. Throws (caller must detach) if it can't. */
  async install(): Promise<void> {
    await this.send('Fetch.enable', this.fetchParams());
    await this.send('Network.setBypassServiceWorker', { bypass: true });
  }

  private fetchParams(): CDPPayload {
    const client = this.clientFetch;
    const patterns = client ? client.patterns : [];
    return {
      patterns: [GUARD_FETCH_PATTERN, ...patterns],
      handleAuthRequests: client?.handleAuthRequests === true,
    };
  }

  /**
   * True when `url` is a document this shield failed before it could commit:
   * Chrome still reports it as the tab's URL (over the error page), which
   * must not trip the post-commit backstop.
   */
  failedBeforeCommit(url: string): boolean {
    return this.failedDocuments.has(url);
  }

  /** Cut the tab: refuse everything from now on and let the bridge detach. */
  block(): void {
    if (this.blockedFlag) return;
    this.blockedFlag = true;
    this.onBlocked();
  }

  // ---------------------------------------------------------------- commands

  /**
   * Run one client command through the shield. `forward` sends the (possibly
   * rewritten) command to the tab; its result is filtered before returning.
   */
  async command(
    method: string,
    params: CDPPayload | undefined,
    forward: Send
  ): Promise<CDPPayload> {
    const input = params ?? {};
    if (this.blockedFlag) refuse(PROTECTED_RULES.refusal);
    await this.admit(method, input);
    const rewritten = this.rewrite(method, input);
    if (rewritten === null) return {};
    // Keep an absent params bag absent when nothing was rewritten.
    const result = await forward(
      method,
      params === undefined && rewritten === input ? undefined : rewritten
    );
    if (this.blockedFlag) refuse(PROTECTED_RULES.refusal);
    return this.after(method, result ?? {});
  }

  private async admit(method: string, params: CDPPayload): Promise<void> {
    const outright = REFUSED_METHODS.get(method);
    if (outright) refuse(outright);
    this.admitBrowserWide(method, params);
    this.admitUrls(method, params);
    if (namesProtectedStorage(params)) refuse(PROTECTED_RULES.refusal);
    this.admitFrame(params);
    this.admitRequestIds(method, params);
    if (method === 'Page.navigateToHistoryEntry') await this.admitHistory(params);
  }

  private admitBrowserWide(method: string, params: CDPPayload): void {
    if (
      (method === 'Browser.setPermission' || method === 'Browser.grantPermissions') &&
      !str(params['origin'])
    ) {
      refuse("browser-wide permissions would reach seven's origin");
    }
    if (method === 'Target.setAutoAttach' && params['autoAttach'] === true) {
      refuse('auto-attach is not supported by the extension bridge');
    }
    if (method === 'Network.setBypassServiceWorker' && params['bypass'] !== true) {
      refuse("service workers stay bypassed so seven's pages cannot load from cache");
    }
  }

  private admitUrls(method: string, params: CDPPayload): void {
    if (COOKIE_SETTERS.has(method)) {
      if (cookieRefused(params)) refuse(COOKIES_REFUSAL);
      return;
    }
    const url = str(params['url']);
    if (url && urlProtected(url)) refuse(PROTECTED_RULES.refusal);
  }

  private admitFrame(params: CDPPayload): void {
    const frameId = str(params['frameId']);
    if (frameId && this.frameProtected(frameId)) refuse(PROTECTED_RULES.refusal);
  }

  private admitRequestIds(method: string, params: CDPPayload): void {
    if (FETCH_ANSWERS.has(method)) {
      const id = str(params['requestId']);
      if (!id || !this.forwarded.has(id)) refuse(PAUSE_REFUSAL);
      return;
    }
    if (BODY_METHODS.has(method)) {
      const id = requestKey(params);
      const state = id ? this.requests.get(id) : undefined;
      if (state === undefined) refuse(UNSEEN_REFUSAL);
      if (state) refuse(PROTECTED_RULES.refusal);
      return;
    }
    if (method === 'IO.read' && !this.streams.has(str(params['handle']) ?? ''))
      refuse(STREAM_REFUSAL);
  }

  private async admitHistory(params: CDPPayload): Promise<void> {
    const history = await this.send('Page.getNavigationHistory', {});
    const entries = Array.isArray(history['entries']) ? history['entries'] : [];
    const entry = entries.find((e) => isObj(e) && e['id'] === params['entryId']);
    const url = isObj(entry) ? (str(entry['url']) ?? '') : '';
    if (urlProtected(url)) refuse(PROTECTED_RULES.refusal);
  }

  /** Rewrite the outbound params; `null` = answered locally, don't send. */
  private rewrite(method: string, params: CDPPayload): CDPPayload | null {
    if (method === 'Fetch.enable') {
      const patterns = Array.isArray(params['patterns'])
        ? params['patterns']
        : [{ urlPattern: '*' }];
      this.clientFetch = { patterns, handleAuthRequests: params['handleAuthRequests'] === true };
      return this.fetchParams();
    }
    if (method === 'Fetch.disable') {
      this.clientFetch = null;
      void this.send('Fetch.enable', this.fetchParams()).catch(() => this.block());
      return null;
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      return { ...params, source: initScriptGuard() + (str(params['source']) ?? '') };
    }
    if (method === 'Page.addScriptToEvaluateOnLoad') {
      return { ...params, scriptSource: initScriptGuard() + (str(params['scriptSource']) ?? '') };
    }
    return params;
  }

  private after(method: string, result: CDPPayload): CDPPayload {
    const stream = str(result['stream']);
    if (stream) this.streams.set(stream, true);
    const resource = result['resource'];
    const resourceStream = isObj(resource) ? str(resource['stream']) : undefined;
    if (resourceStream) this.streams.set(resourceStream, true);
    if (COOKIE_READERS.has(method)) dropProtectedCookies(result);
    if (method === 'Target.getTargetInfo' && isObj(result['targetInfo'])) {
      const info = result['targetInfo'];
      if (isProtectedTarget(str(info['url']) ?? '', false, 'unknown'))
        result['targetInfo'] = redacted(info);
    }
    return result;
  }

  // ------------------------------------------------------------------ events

  /** Filter one debugger event; returns the events to forward (maybe none). */
  onEvent(method: string, params: CDPPayload | undefined): ShieldEvent[] {
    const p = params ?? {};
    if (method === 'Fetch.requestPaused') return this.onPaused(p);
    if (method === 'Fetch.authRequired') return this.onAuth(p);
    this.track(p);
    this.watchCommit(method, p);
    if (method.startsWith('Target.')) return [this.redactTarget(method, p)];
    return this.deliver({ method, params: p });
  }

  private initiatedByProtected(paused: CDPPayload): boolean {
    if (this.frameProtected(str(paused['frameId']) ?? '')) return true;
    const request = paused['request'];
    const headers = isObj(request) && isObj(request['headers']) ? request['headers'] : {};
    return Object.entries(headers).some(([name, value]) => {
      const lower = name.toLowerCase();
      return (
        (lower === 'referer' || lower === 'origin') &&
        value !== 'null' &&
        urlProtected(str(value) ?? '')
      );
    });
  }

  private onPaused(paused: CDPPayload): ShieldEvent[] {
    const id = str(paused['requestId']) ?? '';
    const protectedUrl = urlProtected(requestUrl(paused) ?? '');
    const tainted = protectedUrl || this.initiatedByProtected(paused);
    this.requests.set(id, tainted);
    const networkId = str(paused['networkId']);
    if (networkId) this.requests.set(networkId, tainted || this.requests.get(networkId) === true);
    if (protectedUrl && paused['resourceType'] === 'Document') {
      this.failedDocuments.set(requestUrl(paused) ?? '', true);
      this.answer('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' });
      return [];
    }
    const wanted =
      this.clientFetch?.patterns.some((pattern) => patternMatches(pattern, paused)) === true;
    if (tainted || this.blockedFlag || !wanted) {
      this.answer('Fetch.continueRequest', { requestId: id });
      return [];
    }
    this.forwarded.set(id, true);
    return [{ method: 'Fetch.requestPaused', params: paused }];
  }

  private onAuth(event: CDPPayload): ShieldEvent[] {
    const id = str(event['requestId']) ?? '';
    const protectedUrl = urlProtected(requestUrl(event) ?? '') || this.requests.get(id) === true;
    if (protectedUrl || this.blockedFlag || this.clientFetch?.handleAuthRequests !== true) {
      const response = protectedUrl ? 'CancelAuth' : 'Default';
      this.answer('Fetch.continueWithAuth', { requestId: id, authChallengeResponse: { response } });
      return [];
    }
    this.forwarded.set(id, true);
    return [{ method: 'Fetch.authRequired', params: event }];
  }

  private answer(method: string, params: CDPPayload): void {
    this.send(method, params).catch(() => {
      /* request already gone (tab closed / navigated) */
    });
  }

  private track(params: CDPPayload): void {
    const id = str(params['requestId']);
    const url = requestUrl(params);
    if (!id || url === undefined) return;
    const initiator = params['initiator'];
    const fromProtected =
      urlProtected(str(params['documentURL']) ?? '') ||
      urlProtected(isObj(initiator) ? (str(initiator['url']) ?? '') : '') ||
      this.frameProtected(str(params['frameId']) ?? '');
    const tainted = fromProtected || urlProtected(url) || this.requests.get(id) === true;
    this.requests.set(id, tainted);
  }

  private frameProtected(frameId: string): boolean {
    if (!frameId) return false;
    return (this.frames.get(frameId) ?? []).some(urlProtected);
  }

  private watchCommit(method: string, params: CDPPayload): void {
    if (method === 'Page.frameNavigated' && isObj(params['frame'])) {
      const frame = params['frame'];
      const url = `${str(frame['url']) ?? ''}${str(frame['urlFragment']) ?? ''}`;
      const origin = str(frame['securityOrigin']) ?? '';
      const id = str(frame['id']);
      if (id) this.frames.set(id, [url, origin]);
      if (frame['parentId'] === undefined && (urlProtected(url) || urlProtected(origin)))
        this.block();
      return;
    }
    if (method === 'Runtime.executionContextCreated' && isObj(params['context'])) {
      const context = params['context'];
      const aux = isObj(context['auxData']) ? context['auxData'] : {};
      if (aux['isDefault'] === false) return;
      const origin = str(context['origin']) ?? '';
      const frame = str(aux['frameId']);
      if (frame) this.frames.set(frame, [...(this.frames.get(frame) ?? []), origin]);
      // Any default world on seven's origin means a document slipped past the
      // Fetch block (bfcache, a cached navigation): cut the tab.
      if (urlProtected(origin)) this.block();
    }
  }

  private redactTarget(method: string, params: CDPPayload): ShieldEvent {
    const info = params['targetInfo'];
    if (!isObj(info)) return { method, params };
    const opener = str(info['openerId']) ? 'unknown' : undefined;
    if (!isProtectedTarget(str(info['url']) ?? '', false, opener)) return { method, params };
    return { method, params: { ...params, targetInfo: redacted(info) } };
  }

  private deliver(event: ShieldEvent): ShieldEvent[] {
    const params = event.params ?? {};
    const id = str(params['requestId']);
    if (id && this.requests.get(id) === true) {
      this.held.delete(id);
      return [];
    }
    if (mentions(params)) return [];
    if (id && event.method.endsWith('ExtraInfo')) {
      stripProtectedAssociated(params);
      if (this.requests.get(id) === undefined) {
        this.held.set(id, [...(this.held.get(id) ?? []), event]);
        return [];
      }
    }
    const released = id && this.requests.get(id) === false ? (this.held.delete(id) ?? []) : [];
    return [event, ...released];
  }
}
