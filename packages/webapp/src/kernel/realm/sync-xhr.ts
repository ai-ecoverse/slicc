/**
 * `synchronify` — the channel-agnostic blocking round-trip the realm's
 * synchronous bridges are built on.
 *
 * Runs INSIDE the realm's DedicatedWorker. A **synchronous** `XMLHttpRequest`
 * to a `/__slicc/*` route is intercepted by the controlling Service Worker
 * (`llm-proxy-sw.ts`), round-tripped to the kernel-worker responder, and
 * answered from the calling realm's own capability-token scope. The XHR blocks
 * the realm worker (a different thread from the VFS / shell owner, so no
 * deadlock) until the reply comes back.
 *
 * Synchronous XHR with `responseType='arraybuffer'` + a `timeout` is only
 * permitted OFF the main thread — which is exactly where realm code runs. On
 * any transport failure (timeout / no controlling SW / network error) the call
 * throws an `Error` whose `.code` is a POSIX errno, so it fails closed instead
 * of hanging, and ported Node code's `catch (e) { e.code === '…' }` still works.
 *
 * Extracted from `sync-fs-xhr-bridge.ts` so the fs channel and the exec channel
 * (`sync-exec-xhr-bridge.ts`) share one transport rather than duplicating the
 * marker/errno gates — the security-critical part of this bridge.
 */

// Wire contract shared with the SW handler + responder (single source of
// truth — see sync-fs-wire.ts, a dependency-free module). The MARKER header
// is load-bearing: its ABSENCE on a 2xx means the request was NOT answered by
// our SW handler (a stale/absent SW let it hit the network → SPA fallback
// `200` + `index.html`), so we reject it as EIO rather than reading HTML as
// a genuine payload.
import {
  SYNC_FS_ERRNO_HEADER as ERRNO_HEADER,
  SYNC_FS_MARKER_HEADER as MARKER_HEADER,
  SYNC_FS_TOKEN_HEADER as TOKEN_HEADER,
} from './sync-fs-wire.js';

/** An `Error` carrying a POSIX `.code`, matching sync-fs-cache's error shape. */
export function syncXhrError(code: string, label: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${label}`), { code });
}

export interface SyncXhrRequest {
  method: 'GET' | 'POST';
  /** Same-origin route the controlling SW intercepts. */
  url: string;
  /** Per-realm capability token addressing the caller's scope server-side. */
  token: string;
  /** Raw request body (POST only). */
  body?: Uint8Array;
  /**
   * Hard bound on the blocking wait. The SW handler fails the op closed a
   * margin BEFORE this (so its authoritative errno wins the race with the bare
   * XHR-timeout `EIO`); this is the backstop for a dead SW that never runs the
   * handler at all.
   */
  timeoutMs: number;
  /** Trailing half of the thrown message — e.g. `sync-fs bridge, '/a.txt'`. */
  label: string;
}

/**
 * Issue one blocking round-trip and return the raw response bytes. Throws an
 * errno `Error` on any non-genuine or non-2xx reply.
 */
export function synchronify(req: SyncXhrRequest): Uint8Array {
  const xhr = send(req);
  if (isGenuine(xhr)) return new Uint8Array(xhr.response as ArrayBuffer);
  // 2xx without the marker = SPA fallback / stale SW → not our bytes.
  if (xhr.status >= 200 && xhr.status < 300) throw syncXhrError('EIO', req.label);
  fail(xhr, req.label);
}

/**
 * Same round-trip, parsing the response as JSON. Bytes → text → JSON so the
 * one `responseType` a sync XHR allows (`arraybuffer`) serves both payload
 * shapes. A malformed body from an otherwise-genuine handler fails closed as
 * `EIO` rather than surfacing a `SyntaxError` with no `.code`.
 */
export function synchronifyJson(req: SyncXhrRequest): unknown {
  const bytes = synchronify(req);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw syncXhrError('EIO', req.label);
  }
}

function send(req: SyncXhrRequest): XMLHttpRequest {
  const xhr = new XMLHttpRequest();
  try {
    xhr.open(req.method, req.url, false); // synchronous — realm worker only
    xhr.responseType = 'arraybuffer'; // permitted for sync XHR off the main thread
    xhr.timeout = req.timeoutMs; // bounds a no-controller network hang
    xhr.setRequestHeader(TOKEN_HEADER, req.token);
    if (req.body) xhr.send(new Uint8Array(req.body));
    else xhr.send();
  } catch {
    // ANY failure fails closed as EIO — a sync XHR throws on timeout /
    // network error / no controlling SW, and open/responseType/timeout could
    // in principle reject. Never let a raw error (missing `.code`) escape,
    // and never leave the realm hung.
    throw syncXhrError('EIO', req.label);
  }
  return xhr;
}

/** A 2xx is only trustworthy if our handler stamped the marker. */
function isGenuine(xhr: XMLHttpRequest): boolean {
  return xhr.status >= 200 && xhr.status < 300 && xhr.getResponseHeader(MARKER_HEADER) === '1';
}

function fail(xhr: XMLHttpRequest, label: string): never {
  // Only trust the errno header when OUR handler stamped the marker — symmetric
  // with the 2xx marker gate. A non-2xx lacking the marker isn't ours (a
  // foreign/injected response), so fall back to EIO rather than reading an
  // attacker-supplied x-slicc-fs-errno as authoritative.
  const trusted = xhr.getResponseHeader(MARKER_HEADER) === '1';
  throw syncXhrError((trusted && xhr.getResponseHeader(ERRNO_HEADER)) || 'EIO', label);
}
