/**
 * `llm-proxy-sw-disarm.ts` — lets SLICC seven disarm six's LLM-proxy service
 * worker (ai-ecoverse/slicc-bios: packages 404 under six's worker).
 *
 * On `www.sliccy.ai` six and seven share an origin, and both register a
 * service worker at scope `/` (six `/llm-proxy-sw.js`, seven `/7/sw.js`).
 * When a six tab registers last, every client the browser then creates on
 * the origin — seven's BIOS at `/7/` and its installer SharedWorker included
 * — is controlled by six's worker, which rewrites every cross-origin fetch
 * to `/api/fetch-proxy`. The hosted origin has no fetch proxy, so seven's
 * npm downloads come back as `404 {"error":"Fetch proxy not available in
 * worker mode"}` under npm's URL, and seven can't boot.
 *
 * Seven can replace the registration, but a client keeps the worker it
 * started with until it goes away, so the BIOS page and the installer stay
 * on six's worker for the rest of their lives. The disarm switch lets seven
 * tell that worker to stop answering instead:
 *
 *  - **The message.** A top-level same-origin window posts
 *    `{ type: 'slicc-six-disarm' }` to the worker, with a `MessagePort` to
 *    answer on. The worker stops answering fetches (every request goes to
 *    the network as if no worker were there, for every client it controls)
 *    and answers `{ type: 'slicc-six-disarmed' }`. Any same-origin page can
 *    unregister the worker already, so this grants nothing new; the gate is
 *    the same top-level-window rule as the proxy config (`maySetProxyConfig`).
 *  - **The cookie.** Once seven has moved six's profile it sets
 *    `__Host-slicc-six-retired`. A worker that starts and finds it stays
 *    disarmed, so an evicted-and-restarted worker can't come back armed.
 *    A worker started without the cookie is disarmed only by the message,
 *    for its own lifetime — six keeps working in a browser that hasn't moved.
 */

import { maySetProxyConfig } from './llm-proxy-sw-config.js';

/** Seven → six's worker: stop answering fetches. */
export const SW_SIX_DISARM_MESSAGE = 'slicc-six-disarm';
/** Six's worker → seven: it stopped answering fetches. */
export const SW_SIX_DISARMED_MESSAGE = 'slicc-six-disarmed';
/** Set by seven's BIOS once it has moved six's profile (slicc-bios `sw/six.js`). */
export const SIX_RETIRED_COOKIE = '__Host-slicc-six-retired';

export interface SixDisarmMessage {
  type: typeof SW_SIX_DISARM_MESSAGE;
}

export interface SixDisarmedMessage {
  type: typeof SW_SIX_DISARMED_MESSAGE;
}

/** Exactly `{ type: 'slicc-six-disarm' }`, nothing more. */
export function isSixDisarmMessage(value: unknown): value is SixDisarmMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (value as { type?: unknown }).type === SW_SIX_DISARM_MESSAGE;
}

/** Only a top-level same-origin window may disarm the worker. */
export function maySixDisarm(source: unknown): boolean {
  return maySetProxyConfig(source);
}

interface CookieStoreLike {
  get(name: string): Promise<unknown>;
}

/** Whether seven has retired six in this browser. A missing or failing store reads as no. */
export async function readSixRetired(store: CookieStoreLike | undefined): Promise<boolean> {
  if (!store) return false;
  try {
    return Boolean(await store.get(SIX_RETIRED_COOKIE));
  } catch {
    return false;
  }
}

export interface SixDisarmSwitch {
  /** `true` disarmed, `false` armed, `null` while the startup check runs. */
  readonly disarmed: boolean | null;
  /** Settles with the state once the startup check is done (never rejects). */
  readonly ready: Promise<boolean>;
  /** Disarm for this worker's lifetime. */
  disarm(): void;
}

/**
 * A switch that starts unknown, reads `retired()` once, and can be disarmed at
 * any time. A disarm wins over a later `false` from the startup check.
 */
export function createSixDisarmSwitch(retired: () => Promise<boolean>): SixDisarmSwitch {
  let state: boolean | null = null;
  let disarmedByMessage = false;
  const ready = retired()
    .catch(() => false)
    .then((found) => {
      state = disarmedByMessage || found;
      return state;
    });
  return {
    get disarmed() {
      return disarmedByMessage ? true : state;
    },
    ready: ready.then(() => disarmedByMessage || state === true),
    disarm() {
      disarmedByMessage = true;
      state = true;
    },
  };
}

export interface DisarmableFetchEvent {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

/**
 * Answer `event` with `answer()` unless six is disarmed. Disarmed: no
 * `respondWith`, so the request goes to the network untouched. Unknown (the
 * startup cookie check is still running): answer, and decide inside — a
 * disarmed outcome passes the request on with `passOn` (the worker's `fetch`).
 */
export function answerUnlessDisarmed(
  sixSwitch: SixDisarmSwitch,
  event: DisarmableFetchEvent,
  answer: () => Promise<Response>,
  passOn: (request: Request) => Promise<Response>
): void {
  const disarmed = sixSwitch.disarmed;
  if (disarmed === true) return;
  if (disarmed === false) {
    event.respondWith(answer());
    return;
  }
  event.respondWith(
    sixSwitch.ready.then((nowDisarmed) => (nowDisarmed ? passOn(event.request) : answer()))
  );
}
