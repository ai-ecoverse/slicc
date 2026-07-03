import { CherryHostTransport } from '../cdp/cherry-host-transport.js';
import { BrowserAPI } from '../cdp/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('cherry-boot');

export interface CherryBootResult {
  /** Cherry transport, already connected (handshake complete). */
  transport: CherryHostTransport;
  /** Follower's local BrowserAPI wrapping the cherry transport. */
  browser: BrowserAPI;
  /** Tray join URL the host supplied over the handshake. */
  joinUrl: string;
}

/**
 * Build the cherry transport, complete the host handshake, read the join URL
 * the host supplied, and wrap a BrowserAPI around the transport. Called from
 * `mainStandaloneWorker` when `runtimeMode === 'cherry'`, replacing the default
 * `new BrowserAPI()` / stored-join-URL path.
 */
/**
 * Resolve the embedding (parent) origin the follower hands the transport as its
 * `allowOrigins` / `targetOrigin`. Prefer `location.ancestorOrigins[0]` — the
 * browser-supplied origin of the immediate ancestor frame, unaffected by
 * `Referrer-Policy` and unforgeable by the host page (Chromium/WebKit; the
 * extension float is Chromium-only). Fall back to `document.referrer`, then the
 * follower's own origin.
 *
 * `document.referrer` alone is unreliable: it is stripped on an HTTPS-host →
 * HTTP-iframe downgrade (dev: `https://example.com` embedding
 * `http://localhost:8787`) and by any host page that sends `Referrer-Policy:
 * no-referrer` / `same-origin` — common on third-party pages. The parent is now
 * the `chrome-extension://` side-panel page. An empty referrer left the follower posting
 * its handshake to `location.origin` (itself), which the real cross-origin host
 * never receives, so boot died with a 30s handshake timeout.
 */
function resolveParentOrigin(): string {
  const ancestors = location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) {
    const first = ancestors[0];
    // A sandboxed opaque-origin ancestor reports the literal string "null" —
    // useless as a postMessage targetOrigin, so fall through to the referrer.
    if (first && first !== 'null') return first;
  }
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      // Malformed referrer — fall through to same-origin.
    }
  }
  return location.origin;
}

export async function setupCherryFollower(): Promise<CherryBootResult> {
  const parentOrigin = resolveParentOrigin();
  const allowOrigins = [parentOrigin];
  const targetOrigin = parentOrigin;

  const transport = new CherryHostTransport({
    counterpart: window.parent,
    allowOrigins,
    targetOrigin,
  });
  await transport.connect(); // handshake: receives channelId + the host's joinUrl
  log.info('Cherry transport connected');

  // The join URL arrives directly in the handshake — the host (or its backend)
  // provisioned the leader and supplied a ready join URL.
  const joinUrl = transport.joinUrl;
  if (!joinUrl) {
    throw new Error('cherry boot: no joinUrl from handshake');
  }

  // The handshake above already connected the transport, so the BrowserAPI
  // wraps an already-connected transport. We must NOT call `browser.connect()`
  // here: it re-enters `CherryHostTransport.connect()`, which throws
  // "Cannot connect: state is connected". A swallowed throw on every boot would
  // also hide a genuine transport fault. `BrowserAPI.ensureConnected()` instead
  // (re)connects lazily only when the transport is `disconnected`, so a real
  // drop surfaces to the caller on the next command rather than silently here.
  const browser = new BrowserAPI(transport);
  return { transport, browser, joinUrl };
}
