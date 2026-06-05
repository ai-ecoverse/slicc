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
export async function setupCherryFollower(): Promise<CherryBootResult> {
  const allowOrigins = [document.referrer ? new URL(document.referrer).origin : location.origin];
  const targetOrigin = allowOrigins[0]!;

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
