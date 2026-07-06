import type { Express } from 'express';
import { WebSocket } from 'ws';
import { requireLoopback } from './cloud-status.js';

export interface CdpTargetInfo {
  id?: string;
  targetId?: string;
  type: string;
  url: string;
  attached: boolean;
}

export interface CdpLike {
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
}

export function findSliccPageTarget(
  targets: CdpTargetInfo[],
  pageUrlPrefix: string
): CdpTargetInfo | null {
  const candidates = targets.filter((t) => t.type === 'page' && t.url.startsWith(pageUrlPrefix));
  if (candidates.length === 0) return null;
  return candidates.find((t) => t.attached) ?? candidates[0];
}

export type RestartResult =
  | { ok: true }
  | {
      ok: false;
      code: 'NO_LEADER_TAB' | 'CDP_NOT_READY' | 'CDP_ERROR' | 'INTERNAL';
      message: string;
    };

export async function restartLeader(cdp: CdpLike, pageUrlPrefix: string): Promise<RestartResult> {
  let targets: CdpTargetInfo[];
  try {
    const result = (await cdp.send('Target.getTargets')) as { targetInfos: CdpTargetInfo[] };
    targets = result.targetInfos;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // ECONNREFUSED / timeout / fetch failure → CDP cold-starting (retriable 503).
    // Other failures (malformed response, protocol error) → fatal (500).
    const isTransient = /ECONNREFUSED|timeout|fetch failed|ETIMEDOUT|ENOTFOUND/i.test(msg);
    return {
      ok: false,
      code: isTransient ? 'CDP_NOT_READY' : 'CDP_ERROR',
      message: msg,
    };
  }
  const target = findSliccPageTarget(targets, pageUrlPrefix);
  if (!target) return { ok: false, code: 'NO_LEADER_TAB', message: 'no SLICC page target found' };

  const tid = target.targetId ?? target.id;
  if (!tid) return { ok: false, code: 'INTERNAL', message: 'target missing id' };

  try {
    const { sessionId } = (await cdp.send('Target.attachToTarget', {
      targetId: tid,
      flatten: true,
    })) as { sessionId: string };
    await cdp.send('Page.reload', { ignoreCache: false }, sessionId);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'INTERNAL', message: String(err) };
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id === undefined) return; // event, not a response
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  async send(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const frame = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(frame, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
  close(): void {
    this.socket.close();
  }
}

async function openCdpClient(webSocketDebuggerUrl: string): Promise<CdpClient> {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', (err) => reject(err));
  });
  return new CdpClient(socket);
}

/**
 * HTTP-backed CdpLike. Implements Target.getTargets via the CDP HTTP /json
 * endpoint. Target.attachToTarget + Page.reload are sent over WebSocket.
 */
export function createHttpCdp(cdpPort: number): CdpLike {
  let cachedClient: CdpClient | null = null;
  let cachedWebSocketUrl: string | null = null;

  return {
    async send(method, params, sessionId) {
      if (method === 'Target.getTargets') {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
        const list = (await res.json()) as Array<{
          id: string;
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        // Stash the first page's ws url for subsequent send() calls in
        // the same restartLeader cycle.
        cachedWebSocketUrl =
          list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ??
          null;
        return {
          targetInfos: list.map((t) => ({
            id: t.id,
            type: t.type,
            url: t.url,
            attached: Boolean(t.webSocketDebuggerUrl),
          })),
        };
      }
      if (!cachedClient) {
        if (!cachedWebSocketUrl) {
          throw new Error('createHttpCdp: no ws url cached — call Target.getTargets first');
        }
        cachedClient = await openCdpClient(cachedWebSocketUrl);
      }
      try {
        return await cachedClient.send(method, params, sessionId);
      } finally {
        if (method === 'Page.reload') {
          // Reload severs the session; drop the client so the next
          // restartLeader cycle re-opens.
          cachedClient.close();
          cachedClient = null;
          cachedWebSocketUrl = null;
        }
      }
    },
  };
}

export function registerLeaderRestartEndpoint(
  app: Express,
  options: { cdp: CdpLike; pageUrlPrefix: string }
): void {
  app.post('/api/leader-restart', requireLoopback, async (_req, res) => {
    const result = await restartLeader(options.cdp, options.pageUrlPrefix);
    if (result.ok) {
      res.json({ ok: true });
      return;
    }
    const status = result.code === 'NO_LEADER_TAB' || result.code === 'CDP_NOT_READY' ? 503 : 500;
    res.status(status).json({ error: result.code, message: result.message });
  });
}
