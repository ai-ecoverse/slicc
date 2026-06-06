/**
 * CdpSessionUrlTracker — sniffs the Chrome→Client leg of the CDP WebSocket
 * proxy and maintains a `sessionId -> currentUrl` map keyed the same way
 * navigation-watcher.ts keys its session state. The map feeds the Client→
 * Chrome unmask gate (cdp-unmask.ts) so per-frame unmasking is scoped to
 * the target tab's actual current URL.
 *
 * Three CDP events feed the tracker:
 *   - `Target.attachedToTarget`    → seed via `params.sessionId` + `params.targetInfo.url`
 *   - `Target.targetInfoChanged`   → keyed by `params.targetInfo.targetId`; updates
 *     every session pointing at that target
 *   - `Page.frameNavigated` (root) → `sessionId` lives at the wire-frame top level;
 *     only the root frame (no parentId) updates the session url
 *
 * `Target.detachedFromTarget` clears the entry. Everything else is a no-op.
 *
 * Hostname resolution is done lazily via `getHostname(sessionId)`. Empty,
 * un-parseable, or `about:blank`-style URLs fail closed (return null).
 */

export interface CdpSessionUrlTracker {
  observeChromeToClient(frame: unknown): void;
  getHostname(sessionId: string | undefined): string | null;
  getUrl(sessionId: string | undefined): string | null;
  size(): number;
  clear(): void;
}

interface ParsedFrame {
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseHostname(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return u.hostname;
  } catch {
    return null;
  }
}

export function createCdpSessionUrlTracker(): CdpSessionUrlTracker {
  // sessionId -> targetId
  const sessionToTarget = new Map<string, string>();
  // sessionId -> url
  const sessionToUrl = new Map<string, string>();
  // targetId -> url (last-seen, for hop-back resolution on targetInfoChanged)
  const targetToUrl = new Map<string, string>();

  function setSessionUrl(sessionId: string, url: string | undefined): void {
    if (!url || typeof url !== 'string') return;
    sessionToUrl.set(sessionId, url);
    const targetId = sessionToTarget.get(sessionId);
    if (targetId) targetToUrl.set(targetId, url);
  }

  function handleAttached(frame: ParsedFrame): void {
    const params = frame.params;
    if (!params) return;
    const sessionId = params['sessionId'];
    if (typeof sessionId !== 'string') return;
    const info = asObject(params['targetInfo']);
    if (!info) return;
    const targetId = info['targetId'];
    const url = info['url'];
    if (typeof targetId === 'string') {
      sessionToTarget.set(sessionId, targetId);
      if (typeof url === 'string') targetToUrl.set(targetId, url);
    }
    if (typeof url === 'string') sessionToUrl.set(sessionId, url);
  }

  function handleDetached(frame: ParsedFrame): void {
    const sessionId = frame.params?.['sessionId'];
    if (typeof sessionId !== 'string') return;
    sessionToUrl.delete(sessionId);
    sessionToTarget.delete(sessionId);
  }

  function handleTargetInfoChanged(frame: ParsedFrame): void {
    const info = asObject(frame.params?.['targetInfo']);
    if (!info) return;
    const targetId = info['targetId'];
    const url = info['url'];
    if (typeof targetId !== 'string' || typeof url !== 'string') return;
    targetToUrl.set(targetId, url);
    for (const [sid, tid] of sessionToTarget.entries()) {
      if (tid === targetId) sessionToUrl.set(sid, url);
    }
  }

  function handleFrameNavigated(frame: ParsedFrame): void {
    // sessionId is at the wire-frame top level for routed events.
    const sessionId = frame.sessionId;
    if (typeof sessionId !== 'string') return;
    const inner = asObject(frame.params?.['frame']);
    if (!inner) return;
    // Only the root frame (no parentId) drives the per-tab URL.
    if (typeof inner['parentId'] === 'string') return;
    const url = inner['url'];
    if (typeof url === 'string') setSessionUrl(sessionId, url);
  }

  function observe(raw: unknown): void {
    let frame: ParsedFrame;
    if (typeof raw === 'string') {
      try {
        frame = JSON.parse(raw) as ParsedFrame;
      } catch {
        return;
      }
    } else if (raw && typeof raw === 'object') {
      frame = raw as ParsedFrame;
    } else {
      return;
    }
    if (!frame || typeof frame.method !== 'string') return;
    switch (frame.method) {
      case 'Target.attachedToTarget':
        handleAttached(frame);
        return;
      case 'Target.detachedFromTarget':
        handleDetached(frame);
        return;
      case 'Target.targetInfoChanged':
        handleTargetInfoChanged(frame);
        return;
      case 'Page.frameNavigated':
        handleFrameNavigated(frame);
        return;
      default:
        return;
    }
  }

  return {
    observeChromeToClient: observe,
    getUrl: (sessionId) => (sessionId ? (sessionToUrl.get(sessionId) ?? null) : null),
    getHostname: (sessionId) => parseHostname(sessionId ? sessionToUrl.get(sessionId) : undefined),
    size: () => sessionToUrl.size,
    clear: () => {
      sessionToUrl.clear();
      sessionToTarget.clear();
      targetToUrl.clear();
    },
  };
}
