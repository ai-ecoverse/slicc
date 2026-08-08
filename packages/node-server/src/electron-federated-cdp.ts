// Server-side federated-CDP servicer — the "expose CDP over CDP" core for
// egress-blocked Electron apps (e.g. Signal).
//
// A normal SLICC follower runs the webapp in the target's renderer and lets the
// leader drive its browser over the tray sync protocol (`cdp.request` →
// `cdp.response`/`cdp.event`, `targets.registry`). Signal's renderer blocks all
// network egress, so the webapp can't run there — but the slicc-server DOES have
// the app's raw CDP (the `--cdp-port` it launched Signal with). This servicer
// makes the SERVER the follower's CDP surface: it connects to that raw CDP and
// translates the leader's tray-sync CDP messages to/from it, transparently.
//
// It is TRANSPORT-AGNOSTIC: the caller supplies a `send(FollowerToLeaderMessage)`
// sink and feeds it leader `cdp.request`s via `handleCdpRequest`. Wiring the
// WebRTC data channel (tray-webrtc) that carries these messages to/from the
// leader is a separate phase — WebRTC is proven to work from Signal's renderer,
// and its signalling tunnels over the CDP binding. The translation core here is
// pure + unit-tested, and the CDP driver is validated against a live target.
import {
  type FollowerToLeaderMessage,
  type RemoteTargetInfo,
  sendCDPResponse,
} from '@slicc/shared-ts';
import { WebSocket } from 'ws';

/** A CDP target as returned by `/json/list`. */
export interface FederatedCdpInspectableTarget {
  id: string;
  type: string;
  title?: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Leader → follower CDP request (the `cdp.request` tray-sync variant). */
export interface FederatedCdpRequest {
  requestId: string;
  localTargetId: string;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/**
 * Build a `targets.advertise` message advertising the app's page targets to the
 * leader (which namespaces them into its aggregated `targets.registry`). Only
 * `page`-type targets are exposed — devtools/service-worker/etc. are not
 * driveable follower surfaces. `targetId` is the app's LOCAL CDP target id.
 */
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

/**
 * Translate a raw CDP result/error into the `cdp.response` message(s) to send
 * back to the leader. Delegates to the shared `sendCDPResponse` chunker so an
 * oversize result is split into `chunkData` frames the leader reassembles.
 */
export function buildCdpResponses(
  requestId: string,
  outcome: { result?: Record<string, unknown>; error?: string }
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

/** Translate a raw CDP event frame into a `cdp.event` tray-sync message. */
export function buildCdpEvent(frame: {
  method: string;
  params?: Record<string, unknown>;
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
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/**
 * Connects to the attached app's raw CDP and relays tray-sync CDP messages
 * to/from a leader over an injected transport. Transparent: the leader manages
 * Target attachment / sessions itself (via forwarded `Target.*` requests), so
 * this servicer only maps `requestId ↔ CDP id` and translates envelopes.
 */
export class ElectronFederatedCdp {
  private readonly runtimeId: string;
  private readonly send: (message: FollowerToLeaderMessage) => void;
  private ws: WebSocket | null = null;
  private nextCdpId = 1;
  /** CDP frame id → leader requestId, for correlating responses. */
  private readonly pending = new Map<number, string>();

  constructor(options: {
    runtimeId: string;
    send: (message: FollowerToLeaderMessage) => void;
  }) {
    this.runtimeId = options.runtimeId;
    this.send = options.send;
  }

  /** Open the CDP connection to the browser-level debugger endpoint. */
  async connect(browserWebSocketDebuggerUrl: string): Promise<void> {
    const ws = new WebSocket(browserWebSocketDebuggerUrl);
    this.ws = ws;
    ws.on('message', (data) => this.onCdpFrame(data.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
  }

  /** Advertise the app's page targets to the leader (from `/json/list`). */
  advertiseTargets(targets: FederatedCdpInspectableTarget[]): void {
    this.send(buildTargetsAdvertise(this.runtimeId, targets));
  }

  /** Service one leader `cdp.request`: forward it to the app's CDP (preserving
   *  `sessionId`) and correlate the eventual response by requestId. */
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
      // A socket that goes CLOSING between the OPEN check above and here makes
      // `ws.send` throw synchronously; without this the leader's requestId is
      // stranded until `stop()` rejects it (long after the leader's own
      // timeout). Mirrors FederatedCDPServicer.handleCdpRequest in swift-server.
      this.pending.delete(id);
      for (const message of buildCdpResponses(request.requestId, {
        error: `cdp-send-failed: ${err instanceof Error ? err.message : String(err)}`,
      })) {
        this.send(message);
      }
    }
  }

  /** Close the CDP connection and reject any in-flight requests. */
  stop(): void {
    for (const requestId of this.pending.values()) {
      for (const message of buildCdpResponses(requestId, { error: 'cdp-closed' })) {
        this.send(message);
      }
    }
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      // ignore close failures
    }
    this.ws = null;
  }

  private onCdpFrame(raw: string): void {
    let frame: RawCdpFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    // A response carries an `id`; an event carries a `method` and no `id`.
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
