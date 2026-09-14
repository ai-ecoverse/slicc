// biome-ignore lint/plugin: parsed third-party WS frame body — genuinely arbitrary JSON with no shape to name; narrowed structurally by isPlainObject/subsetMatch.
type JsonObject = Record<string, unknown>;

interface PageRouterGlobals {
  __sliccWsRouter?: unknown;
  __sliccWsRouterReport?: (s: string) => void;
  WebSocket?: typeof WebSocket;
}

export function installWsRouter(win: typeof globalThis): void {
  const w = win as unknown as PageRouterGlobals;
  if (w.__sliccWsRouter) return;

  interface Selector {
    parseAs?: 'json' | 'text';
    where?: JsonObject;
    project?: readonly string[];
  }
  interface Subscriber {
    id: string;
    urlMatch?: string;
    filter?: Selector;

    _urlMatchRe?: RegExp | null;
  }
  interface SubscriberPatch {
    urlMatch?: string | null;
    filter?: Selector | null;
  }

  const subs = new Map<string, Subscriber>();

  function compileUrlMatch(pattern: string | undefined): RegExp | null | undefined {
    if (pattern === undefined) return undefined;
    try {
      return new RegExp(pattern);
    } catch {
      return null;
    }
  }

  function isPlainObject(v: unknown): v is JsonObject {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function subsetMatch(value: JsonObject, template: JsonObject): boolean {
    for (const k of Object.keys(template)) {
      const expected = template[k];
      const actual = value[k];
      if (isPlainObject(expected)) {
        if (!isPlainObject(actual)) return false;
        if (!subsetMatch(actual, expected)) return false;
        continue;
      }
      if (!Object.is(actual, expected)) return false;
    }
    return true;
  }

  function parseFrame(raw: string, parseAs: 'json' | 'text' | undefined): unknown {
    if (parseAs === 'text') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  function project(body: unknown, fields: readonly string[] | undefined): unknown {
    if (!fields || fields.length === 0) return body;
    if (!isPlainObject(body)) return body;
    const out: JsonObject = {};
    for (const f of fields) if (f in body) out[f] = body[f];
    return out;
  }

  function report(subId: string, payload: unknown): void {
    const reporter = w.__sliccWsRouterReport;
    if (typeof reporter !== 'function') return;
    try {
      reporter(JSON.stringify({ subId, payload }));
    } catch {}
  }

  function urlMatches(sub: Subscriber, url: string): boolean {
    if (sub.urlMatch === undefined) return true;
    const re = sub._urlMatchRe;

    if (re === null) return false;
    return !re || re.test(url);
  }

  function whereMatches(sub: Subscriber, body: unknown): boolean {
    const where = sub.filter?.where;
    if (!where || Object.keys(where).length === 0) return true;
    if (!isPlainObject(body)) return false;
    return subsetMatch(body, where);
  }

  function dispatchFrame(url: string, raw: string): void {
    if (subs.size === 0) return;
    for (const sub of subs.values()) {
      if (!urlMatches(sub, url)) continue;
      const body = parseFrame(raw, sub.filter?.parseAs);
      if (body === undefined) continue;
      if (!whereMatches(sub, body)) continue;
      report(sub.id, project(body, sub.filter?.project));
    }
  }

  const seen = new WeakSet<WebSocket>();
  function wrapInstance(ws: WebSocket): void {
    if (seen.has(ws)) return;
    seen.add(ws);
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      try {
        dispatchFrame(ws.url, ev.data);
      } catch {}
    });
  }

  const WS = w.WebSocket;
  if (!WS) return;
  const origSend = WS.prototype.send;
  WS.prototype.send = function patchedSend(this: WebSocket, data: unknown): void {
    wrapInstance(this);
    origSend.call(this, data as string);
  };

  function applyUrlMatchPatch(next: Subscriber, patch: SubscriberPatch): void {
    if (!Object.prototype.hasOwnProperty.call(patch, 'urlMatch')) return;
    if (patch.urlMatch === null) {
      delete next.urlMatch;
      next._urlMatchRe = undefined;
      return;
    }
    if (typeof patch.urlMatch === 'string') {
      next.urlMatch = patch.urlMatch;
      next._urlMatchRe = compileUrlMatch(patch.urlMatch);
    }
  }

  function applyFilterPatch(next: Subscriber, patch: SubscriberPatch): void {
    if (!Object.prototype.hasOwnProperty.call(patch, 'filter')) return;
    if (patch.filter === null) {
      delete next.filter;
      return;
    }
    if (patch.filter !== undefined) {
      next.filter = patch.filter;
    }
  }

  const router = {
    register(sub: Subscriber): void {
      subs.set(sub.id, { ...sub, _urlMatchRe: compileUrlMatch(sub.urlMatch) });
    },

    update(id: string, patch: SubscriberPatch): void {
      const cur = subs.get(id);
      if (!cur) return;
      const next: Subscriber = { ...cur, id };
      applyUrlMatchPatch(next, patch);
      applyFilterPatch(next, patch);
      subs.set(id, next);
    },
    unregister(id: string): void {
      subs.delete(id);
    },

    _dispatch: dispatchFrame,
  };
  Object.defineProperty(w, '__sliccWsRouter', { value: router, configurable: false });
}

export const WS_ROUTER_SOURCE = `(${installWsRouter.toString()})(globalThis);`;
