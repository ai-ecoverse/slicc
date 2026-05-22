import { type Express } from 'express';
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
  localUrlPrefix: string
): CdpTargetInfo | null {
  const candidates = targets.filter((t) => t.type === 'page' && t.url.startsWith(localUrlPrefix));
  if (candidates.length === 0) return null;
  return candidates.find((t) => t.attached) ?? candidates[0];
}

export interface RestartResult {
  ok: boolean;
  code?: 'NO_LEADER_TAB' | 'CDP_NOT_READY' | 'INTERNAL';
  message?: string;
}

export async function restartLeader(cdp: CdpLike, localUrlPrefix: string): Promise<RestartResult> {
  let targets: CdpTargetInfo[];
  try {
    const result = (await cdp.send('Target.getTargets')) as { targetInfos: CdpTargetInfo[] };
    targets = result.targetInfos;
  } catch (err) {
    return { ok: false, code: 'CDP_NOT_READY', message: String(err) };
  }
  const target = findSliccPageTarget(targets, localUrlPrefix);
  if (!target) return { ok: false, code: 'NO_LEADER_TAB' };

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

/**
 * HTTP-backed CdpLike. Implements Target.getTargets via the CDP HTTP /json
 * endpoint. Target.attachToTarget + Page.reload over WebSocket are deferred
 * to Task 3.4b — calling them on this implementation throws.
 */
export function createHttpCdp(cdpPort: number): CdpLike {
  return {
    async send(method, _params, _sessionId) {
      if (method === 'Target.getTargets') {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
        const list = (await res.json()) as Array<{
          id: string;
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        return {
          targetInfos: list.map((t) => ({
            id: t.id,
            type: t.type,
            url: t.url,
            attached: Boolean(t.webSocketDebuggerUrl),
          })),
        };
      }
      // Task 3.4b will implement Target.attachToTarget + Page.reload over ws,
      // following the attachConsoleForwarder pattern in index.ts (~line 251).
      // Until then, this is a load-bearing TODO that surfaces clearly if hit.
      throw new Error(`createHttpCdp: ${method} not yet implemented (Task 3.4b)`);
    },
  };
}

export function registerLeaderRestartEndpoint(
  app: Express,
  options: { cdp: CdpLike; localUrlPrefix: string }
): void {
  app.post('/api/leader-restart', requireLoopback, async (_req, res) => {
    const result = await restartLeader(options.cdp, options.localUrlPrefix);
    if (result.ok) {
      res.json({ ok: true });
      return;
    }
    const status = result.code === 'NO_LEADER_TAB' || result.code === 'CDP_NOT_READY' ? 503 : 500;
    res.status(status).json({ error: result.code, message: result.message ?? null });
  });
}
