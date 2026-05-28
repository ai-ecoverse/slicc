/**
 * `ws-router-page.ts` — the page-side WebSocket frame router.
 *
 * Injected into a target tab once per tab by `WsSubscriberRegistry`
 * via `Page.addScriptToEvaluateOnNewDocument` (for future loads) and
 * `Runtime.evaluate` (for the current document). Subsequent
 * subscribers register selectors with the already-installed router
 * rather than re-patching the prototype — which is the Wave 4.1
 * security-review hard rule.
 *
 * The script is the runtime's audited replacement for the
 * skill-injected `WebSocket.prototype.send` patches the security
 * review flagged in `slack.jsh`. Three properties matter:
 *  1. It's a single static source — a static scanner can read it
 *     instead of a string-built blob.
 *  2. It does NOT observe outbound frames. `WebSocket.prototype.send`
 *     is hooked purely as a discovery mechanism for new WS instances
 *     so the inbound `message` listener can be attached.
 *  3. Skill code never reaches `fetch()` from the third-party origin;
 *     matched projections cross back to the host via the
 *     `__sliccWsRouterReport` binding installed via
 *     `Runtime.addBinding`.
 */

/**
 * The router IIFE that runs inside the page. Declared as a function
 * so unit tests can call `installWsRouter(fakeWindow)` directly; the
 * production injection path stringifies the function body via
 * `WS_ROUTER_SOURCE`.
 *
 * The function is fully self-contained — no closures over outer
 * scope — because once stringified it runs in a separate global.
 */
export function installWsRouter(win: typeof globalThis): void {
  const w = win as unknown as Record<string, unknown>;
  if (w.__sliccWsRouter) return;

  interface Selector {
    parseAs?: 'json' | 'text';
    where?: Record<string, unknown>;
    project?: readonly string[];
  }
  interface Subscriber {
    id: string;
    urlMatch?: string;
    filter?: Selector;
  }

  const subs = new Map<string, Subscriber>();

  function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
  function subsetMatch(value: Record<string, unknown>, template: Record<string, unknown>): boolean {
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
    const out: Record<string, unknown> = {};
    for (const f of fields) if (f in body) out[f] = (body as Record<string, unknown>)[f];
    return out;
  }
  function report(subId: string, payload: unknown): void {
    const reporter = (w as { __sliccWsRouterReport?: (s: string) => void }).__sliccWsRouterReport;
    if (typeof reporter !== 'function') return;
    try {
      reporter(JSON.stringify({ subId, payload }));
    } catch {
      /* drop unreportable frame */
    }
  }
  function dispatchFrame(url: string, raw: string): void {
    if (subs.size === 0) return;
    for (const sub of subs.values()) {
      if (sub.urlMatch) {
        try {
          if (!new RegExp(sub.urlMatch).test(url)) continue;
        } catch {
          continue;
        }
      }
      const body = parseFrame(raw, sub.filter?.parseAs);
      if (body === undefined) continue;
      if (sub.filter?.where && Object.keys(sub.filter.where).length > 0) {
        if (!isPlainObject(body)) continue;
        if (!subsetMatch(body, sub.filter.where)) continue;
      }
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
      } catch {
        /* never let router errors surface into the page */
      }
    });
  }

  const WS = (win as unknown as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) return;
  const origSend = WS.prototype.send;
  WS.prototype.send = function patchedSend(this: WebSocket, data: unknown): void {
    wrapInstance(this);
    return origSend.call(this, data as string);
  };

  const router = {
    register(sub: Subscriber): void {
      subs.set(sub.id, sub);
    },
    update(id: string, sub: Partial<Subscriber>): void {
      const cur = subs.get(id);
      if (!cur) return;
      subs.set(id, { ...cur, ...sub, id });
    },
    unregister(id: string): void {
      subs.delete(id);
    },
    /** Internal — exposed for tests. */
    _dispatch: dispatchFrame,
  };
  Object.defineProperty(w, '__sliccWsRouter', { value: router, configurable: false });
}

/** Stringified router source for CDP injection. */
export const WS_ROUTER_SOURCE = `(${installWsRouter.toString()})(globalThis);`;
