import {
  type CDPPayload,
  type FollowerToLeaderMessage,
  type RemoteTargetInfo,
  sendCDPResponse,
} from '@slicc/shared-ts';
import { WebSocket } from 'ws';

export interface FederatedCdpInspectableTarget {
  id: string;
  type: string;
  title?: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface FederatedCdpRequest {
  requestId: string;
  localTargetId: string;
  method: string;

  params?: CDPPayload;
  sessionId?: string;
}

export function buildTargetsAdvertise(
  runtimeId: string,
  targets: FederatedCdpInspectableTarget[]
): Extract<FollowerToLeaderMessage, { type: 'targets.advertise' }> {
  const entries: RemoteTargetInfo[] = targets
    .filter((t) => t.type === 'page')
    .map((t) => ({
      targetId: t.id,
      title: t.title ?? '',
      url: t.url,
      kind: 'browser',
    }));
  return { type: 'targets.advertise', targets: entries, runtimeId };
}

export function buildCdpResponses(
  requestId: string,
  outcome: { result?: CDPPayload; error?: string }
): Array<Extract<FollowerToLeaderMessage, { type: 'cdp.response' }>> {
  const messages: Array<Extract<FollowerToLeaderMessage, { type: 'cdp.response' }>> = [];
  sendCDPResponse(
    {
      send: (message) => {
        if (message.type === 'cdp.response') {
          messages.push(message as Extract<FollowerToLeaderMessage, { type: 'cdp.response' }>);
        }
        return true;
      },
    },
    requestId,
    outcome.result,
    outcome.error
  );
  return messages;
}

export function buildCdpEvent(frame: {
  method: string;

  params?: CDPPayload;
  sessionId?: string;
}): Extract<FollowerToLeaderMessage, { type: 'cdp.event' }> {
  return {
    type: 'cdp.event',
    method: frame.method,
    params: frame.params ?? {},
    sessionId: frame.sessionId,
  };
}

interface RawCdpFrame {
  id?: number;
  method?: string;

  params?: CDPPayload;
  sessionId?: string;

  result?: CDPPayload;
  error?: { message?: string };
}

export class ElectronFederatedCdp {
  private readonly runtimeId: string;
  private readonly send: (message: FollowerToLeaderMessage) => void;
  private ws: WebSocket | null = null;
  private nextCdpId = 1;

  private readonly pending = new Map<number, string>();

  constructor(options: {
    runtimeId: string;
    send: (message: FollowerToLeaderMessage) => void;
  }) {
    this.runtimeId = options.runtimeId;
    this.send = options.send;
  }

  async connect(browserWebSocketDebuggerUrl: string): Promise<void> {
    const ws = new WebSocket(browserWebSocketDebuggerUrl);
    this.ws = ws;
    ws.on('message', (data) => this.onCdpFrame(data.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
  }

  advertiseTargets(targets: FederatedCdpInspectableTarget[]): void {
    this.send(buildTargetsAdvertise(this.runtimeId, targets));
  }

  handleCdpRequest(request: FederatedCdpRequest): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      for (const message of buildCdpResponses(request.requestId, { error: 'cdp-not-connected' })) {
        this.send(message);
      }
      return;
    }
    const id = this.nextCdpId++;
    this.pending.set(id, request.requestId);
    const frame: RawCdpFrame = { id, method: request.method, params: request.params ?? {} };
    if (request.sessionId) frame.sessionId = request.sessionId;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      this.pending.delete(id);
      for (const message of buildCdpResponses(request.requestId, {
        error: `cdp-send-failed: ${err instanceof Error ? err.message : String(err)}`,
      })) {
        this.send(message);
      }
    }
  }

  stop(): void {
    for (const requestId of this.pending.values()) {
      for (const message of buildCdpResponses(requestId, { error: 'cdp-closed' })) {
        this.send(message);
      }
    }
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  private onCdpFrame(raw: string): void {
    let frame: RawCdpFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof frame.id === 'number') {
      const requestId = this.pending.get(frame.id);
      if (requestId === undefined) return;
      this.pending.delete(frame.id);
      const outcome = frame.error
        ? { error: frame.error.message ?? 'cdp-error' }
        : { result: frame.result ?? {} };
      for (const message of buildCdpResponses(requestId, outcome)) this.send(message);
      return;
    }
    if (typeof frame.method === 'string') {
      this.send(
        buildCdpEvent({ method: frame.method, params: frame.params, sessionId: frame.sessionId })
      );
    }
  }
}
