export interface CdpSessionUrlTracker {
  observeChromeToClient(frame: unknown): void;
  getHostname(sessionId: string | undefined): string | null;
  getUrl(sessionId: string | undefined): string | null;
  size(): number;
  clear(): void;
}

interface CdpTargetInfoSlice {
  targetId?: string;
  url?: string;
  type?: string;
}

interface CdpFrameSlice {
  id?: string;
  parentId?: string;
  url?: string;
}

interface SessionUrlTrackerFrameParams {
  sessionId?: string;
  targetInfo?: unknown;
  frame?: unknown;
}

interface ParsedFrame {
  method?: string;
  sessionId?: string;
  params?: SessionUrlTrackerFrameParams;
}

function asTargetInfo(v: unknown): CdpTargetInfoSlice | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as CdpTargetInfoSlice;
}

function asFrameInfo(v: unknown): CdpFrameSlice | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as CdpFrameSlice;
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
  const sessionToTarget = new Map<string, string>();

  const sessionToUrl = new Map<string, string>();

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
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string') return;
    const info = asTargetInfo(params.targetInfo);
    if (!info) return;
    const targetId = info.targetId;
    const url = info.url;
    if (typeof targetId === 'string') {
      sessionToTarget.set(sessionId, targetId);
      if (typeof url === 'string') targetToUrl.set(targetId, url);
    }
    if (typeof url === 'string') sessionToUrl.set(sessionId, url);
  }

  function handleDetached(frame: ParsedFrame): void {
    const sessionId = frame.params?.sessionId;
    if (typeof sessionId !== 'string') return;
    sessionToUrl.delete(sessionId);
    sessionToTarget.delete(sessionId);
  }

  function handleTargetInfoChanged(frame: ParsedFrame): void {
    const info = asTargetInfo(frame.params?.targetInfo);
    if (!info) return;
    const targetId = info.targetId;
    const url = info.url;
    if (typeof targetId !== 'string' || typeof url !== 'string') return;
    targetToUrl.set(targetId, url);
    for (const [sid, tid] of sessionToTarget.entries()) {
      if (tid === targetId) sessionToUrl.set(sid, url);
    }
  }

  function handleFrameNavigated(frame: ParsedFrame): void {
    const sessionId = frame.sessionId;
    if (typeof sessionId !== 'string') return;
    const inner = asFrameInfo(frame.params?.frame);
    if (!inner) return;

    if (typeof inner.parentId === 'string') return;
    const url = inner.url;
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
