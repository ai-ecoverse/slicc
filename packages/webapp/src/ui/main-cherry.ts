import { CherryHostTransport } from '../cdp/cherry-host-transport.js';
import { BrowserAPI } from '../cdp/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('cherry-boot');

/** Provisioning payload the host SDK forwards over the handshake (Task 3 captures it). */
export interface CherryProvisioningAuth {
  token: string;
  coneName?: string;
  createIfMissing?: boolean;
}

export interface CherryBootResult {
  /** Cherry transport, already connected (handshake complete). */
  transport: CherryHostTransport;
  /** Follower's local BrowserAPI wrapping the cherry transport. */
  browser: BrowserAPI;
  /** Tray join URL resolved from the handshake (or provisioned from an IMS token). */
  joinUrl: string;
}

/**
 * Iframe-side cloud provisioning (same-origin /api/cloud/*). Mirrors the spec's
 * 5-step flow: list → resume/use-running → start-if-missing. Returns a join URL.
 * The Bearer token never leaves this same-origin call and is not persisted.
 */
async function resolveCherryJoinUrl(auth: CherryProvisioningAuth): Promise<string> {
  const authHeader = { Authorization: `Bearer ${auth.token}` };
  const listRes = await fetch('/api/cloud/list?json=true', { headers: authHeader });
  if (!listRes.ok)
    throw new Error(`cherry provisioning: /api/cloud/list failed (${listRes.status})`);
  const cones = (await listRes.json()) as Array<{
    name: string;
    status: string;
    sandboxId?: string;
    joinUrl?: string;
  }>;
  const match = auth.coneName ? cones.find((c) => c.name === auth.coneName) : undefined;
  if (match) {
    if (match.status === 'running' && match.joinUrl) return match.joinUrl;
    if (match.status === 'paused' && match.sandboxId) {
      const resumed = await fetch('/api/cloud/resume?json=true', {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId: match.sandboxId }),
      });
      if (!resumed.ok) throw new Error(`cherry provisioning: resume failed (${resumed.status})`);
      const { joinUrl } = (await resumed.json()) as { joinUrl: string };
      return joinUrl;
    }
  }
  if (auth.createIfMissing) {
    const started = await fetch('/api/cloud/start?json=true', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: auth.coneName }),
    });
    if (!started.ok) throw new Error(`cherry provisioning: start failed (${started.status})`);
    const { joinUrl } = (await started.json()) as { joinUrl: string };
    return joinUrl;
  }
  throw new Error('cherry provisioning: no matching cone and createIfMissing is false');
}

/**
 * Build the cherry transport, complete the host handshake, resolve a join URL,
 * and wrap a BrowserAPI around the transport. Called from `mainStandaloneWorker`
 * when `runtimeMode === 'cherry'`, replacing the default
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
  await transport.connect(); // handshake: receives channelId + provisioning payload (joinUrl or auth)
  log.info('Cherry transport connected');

  // joinUrl arrives directly in the handshake, OR is provisioned iframe-side
  // from an IMS token. Both `transport.joinUrl` and `transport.provisioningAuth`
  // are captured in Task 3's handshake.welcome handler.
  let joinUrl = transport.joinUrl;
  if (!joinUrl && transport.provisioningAuth) {
    joinUrl = await resolveCherryJoinUrl(transport.provisioningAuth);
  }
  if (!joinUrl) {
    throw new Error('cherry boot: no joinUrl from handshake and no provisioning auth');
  }

  const browser = new BrowserAPI(transport);
  try {
    await browser.connect();
  } catch (err) {
    log.warn('Cherry CDP connect failed; will retry on demand', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { transport, browser, joinUrl };
}
