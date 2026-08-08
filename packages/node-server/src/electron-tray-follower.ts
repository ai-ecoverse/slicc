// Headless tray follower for an egress-blocked Electron app (e.g. Signal).
//
// A normal SLICC follower runs the webapp in the target's renderer and joins
// the tray over WebRTC; Signal blocks renderer egress, so the webapp can't run
// there — but the slicc-server has network AND the app's raw CDP. This makes the
// SERVER the follower: it joins the tray (HTTP signalling), answers the leader's
// WebRTC offer, opens the `tray-control` data channel, and runs the tray-sync
// protocol over it — servicing the leader's `cdp.request`s against the app's raw
// CDP via `ElectronFederatedCdp`. Mirrors the webapp's `tray-webrtc.ts` /
// `slicc-cli`'s Go follower (same signalling + `hello` handshake + data-channel
// label), reusing the shared wire types.
import { randomUUID } from 'node:crypto';
import {
  type FollowerToLeaderMessage,
  isTrayChunkFrame,
  type LeaderToFollowerMessage,
  TRAY_MAX_PENDING_REASSEMBLIES,
  TRAY_SYNC_PROTOCOL_VERSION,
  type TrayChunkFrame,
} from '@slicc/shared-ts';
// werift is a pure-TS WebRTC stack (no native build) that interops with the
// browser leader's RTCPeerConnection.
import {
  type RTCDataChannel,
  type RTCIceCandidate,
  type RTCIceCandidateInit,
  RTCPeerConnection,
} from 'werift';
import {
  ElectronFederatedCdp,
  type FederatedCdpInspectableTarget,
} from './electron-federated-cdp.js';

/** The data-channel the leader opens; mirrors `tray-webrtc.ts`. */
export const TRAY_CONTROL_CHANNEL_LABEL = 'tray-control';
/** Runtime tag advertised on attach + `hello`. */
export const FOLLOWER_RUNTIME_TAG = 'slicc-electron';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cap on a single tray-signalling round-trip. `stop()` cannot abort an
 *  in-flight fetch, so without this a hung hub / black-holing proxy would wedge
 *  `attachWithRedirects` (or a poll) forever. */
const SIGNALLING_TIMEOUT_MS = 10_000;

/** Bound on the bootstrap-event de-dup set so a long-lived follower can't grow
 *  it without limit (`cursor` already gates re-delivery; this is belt-only). */
const MAX_SEEN_EVENTS = 512;

interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Minimal tray follower-bootstrap signalling client (mirrors slicc-cli's
 *  `internal/signaling`): POSTs join/poll/answer/ice to the join URL. */
export class TrayFollowerSignaling {
  constructor(
    private readonly joinUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(this.joinUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SIGNALLING_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`tray signalling ${res.status} ${res.statusText}`);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Attach to the tray. Unlike poll/answer/ice, this tolerates a non-OK status
   * and returns the decoded body: the tray signals `TRAY_SUPERSEDED` with an
   * HTTP 409 + a replacement `joinUrl`, and `wait` plans (leader not yet
   * elected/connected) can also arrive on a non-2xx status. Throwing before
   * decoding — as `post()` does — would strand the follower on both.
   * `attachWithRedirects` interprets `result.code` / `result.action`.
   */
  async attach(
    controllerId: string,
    runtime: string
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.fetchImpl(this.joinUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId, runtime }),
      signal: AbortSignal.timeout(SIGNALLING_TIMEOUT_MS),
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error body (e.g. a bare 5xx) — leave it empty; a bootstrap-less,
      // code-less result is treated as a terminal attach failure by the caller.
    }
    return { status: res.status, body };
  }
  poll(
    controllerId: string,
    bootstrapId: string,
    cursor: number
  ): Promise<Record<string, unknown>> {
    return this.post({ action: 'poll', controllerId, bootstrapId, cursor });
  }
  sendAnswer(
    controllerId: string,
    bootstrapId: string,
    sdp: string
  ): Promise<Record<string, unknown>> {
    return this.post({
      action: 'answer',
      controllerId,
      bootstrapId,
      answer: { type: 'answer', sdp },
    });
  }
  sendIceCandidate(
    controllerId: string,
    bootstrapId: string,
    candidate: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.post({ action: 'ice-candidate', controllerId, bootstrapId, candidate });
  }
}

export interface ElectronTrayFollowerOptions {
  /** Tray join URL (the slicc-server's `--join` value). */
  joinUrl: string;
  /** Browser-level CDP debugger websocket of the attached app (from `/json/version`). */
  browserWsUrl: string;
  /** Enumerate the app's inspectable targets (from `/json/list`) to advertise. */
  listTargets: () => Promise<FederatedCdpInspectableTarget[]>;
  /** Stable id for this follower runtime. Defaults to a fresh UUID. */
  runtimeId?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  logger?: (message: string) => void;
}

/**
 * Ties the signalling + WebRTC + tray-sync + federated-CDP pieces together. The
 * pure message-dispatch logic is exposed via {@link dispatchLeaderMessage} for
 * unit testing; the WebRTC/signalling glue is validated end-to-end against a
 * mock leader + a live CDP target.
 */
export class ElectronTrayFollower {
  private readonly opts: Required<
    Pick<ElectronTrayFollowerOptions, 'joinUrl' | 'browserWsUrl' | 'listTargets'>
  > &
    ElectronTrayFollowerOptions;
  private readonly runtimeId: string;
  private readonly controllerId = randomUUID();
  /** Reassigned when the tray supersedes and hands us a fresh join URL. */
  private signaling: TrayFollowerSignaling;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (m: string) => void;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private cdp: ElectronFederatedCdp | null = null;
  private bootstrapId = '';
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private cursor = 0;
  private stopped = false;
  private readonly seenEvents = new Set<string>();
  /** Bounded reconnect state — a dropped tray-control channel re-joins. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private readonly maxReconnects = 10;
  /** Reassembles oversize (`__chunk`-framed) leader messages before dispatch. */
  private readonly reassembler = new ChunkReassembler();

  constructor(options: ElectronTrayFollowerOptions) {
    this.opts = options as ElectronTrayFollower['opts'];
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.signaling = new TrayFollowerSignaling(options.joinUrl, this.fetchImpl);
    this.log = options.logger ?? (() => {});
  }

  /**
   * Attach to the tray, resolving the non-terminal attach outcomes the worker
   * returns before a bootstrap is available:
   *  - `TRAY_SUPERSEDED` (HTTP 409 + `joinUrl`): the leader reconnected onto a
   *    fresh tray — follow the redirect (bounded hops).
   *  - `wait` (leader not yet elected/connected, carries `retryAfterMs`): sleep
   *    then re-attach (bounded), as the shared Swift/Go followers do — otherwise
   *    a follower that raced leader election resolves "started" but is never
   *    discovered.
   *  - bootstrap present: return the ICE servers to start WebRTC.
   *
   * Exposed for unit tests (signalling only, no WebRTC). Returns null on a
   * terminal failure or once the follower is stopped.
   */
  async attachWithRedirects(maxHops = 4, maxWaits = 30): Promise<IceServerConfig[] | null> {
    let hops = 0;
    let waits = 0;
    while (!this.stopped) {
      const { body } = await this.signaling.attach(this.controllerId, FOLLOWER_RUNTIME_TAG);
      const result = body['result'] as Record<string, unknown> | undefined;
      const bootstrap = result?.['bootstrap'] as { bootstrapId?: string } | undefined;
      if (bootstrap?.bootstrapId) {
        this.bootstrapId = bootstrap.bootstrapId;
        return normalizeIceServers(body['iceServers']);
      }
      const supersededUrl = result?.['joinUrl'];
      if (result?.['code'] === 'TRAY_SUPERSEDED' && typeof supersededUrl === 'string') {
        if (++hops > maxHops) {
          this.log('[electron-follower] too many supersede hops — giving up');
          return null;
        }
        this.log(`[electron-follower] tray superseded → following ${supersededUrl}`);
        this.signaling = new TrayFollowerSignaling(supersededUrl, this.fetchImpl);
        continue;
      }
      if (result?.['action'] === 'wait') {
        if (++waits > maxWaits) {
          this.log('[electron-follower] leader never became ready — giving up');
          return null;
        }
        const retryAfterMs =
          typeof result['retryAfterMs'] === 'number' ? (result['retryAfterMs'] as number) : 1000;
        this.log(
          `[electron-follower] leader not ready (${String(result['code'])}) — retry in ${retryAfterMs}ms`
        );
        await sleep(retryAfterMs);
        continue;
      }
      this.log(`[electron-follower] attach failed: ${JSON.stringify(result)}`);
      return null;
    }
    return null;
  }

  /** Join the tray, answer the leader's offer, and start servicing CDP. */
  async start(): Promise<void> {
    await this.joinOnce();
  }

  /** One join attempt: attach → WebRTC answerer → federated-CDP servicer. Runs
   *  again on reconnect after the tray-control channel drops. */
  private async joinOnce(): Promise<void> {
    const iceServers = await this.attachWithRedirects();
    if (iceServers === null || this.stopped) return;
    this.log(
      `[electron-follower] attached tray, bootstrap=${this.bootstrapId}, ice=${iceServers.length}`
    );

    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    pc.onIceCandidate.subscribe((cand: RTCIceCandidate | undefined) => {
      if (!cand || !this.bootstrapId) return;
      void this.signaling
        .sendIceCandidate(
          this.controllerId,
          this.bootstrapId,
          cand.toJSON() as Record<string, unknown>
        )
        .catch((e) => this.log(`[electron-follower] sendIce failed: ${String(e)}`));
    });
    pc.onDataChannel.subscribe((ch: RTCDataChannel) => {
      if (ch.label === TRAY_CONTROL_CHANNEL_LABEL) this.wireControlChannel(ch);
    });

    // Federated-CDP servicer: sends follower→leader messages over the channel.
    this.cdp = new ElectronFederatedCdp({
      runtimeId: this.runtimeId,
      send: (message) => this.sendToLeader(message),
    });
    await this.cdp.connect(this.opts.browserWsUrl);

    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardownPeer();
  }

  /**
   * The tray-control channel left `open` (ICE failure, leader restart, or
   * transient network loss). Re-join the tray with capped exponential backoff,
   * as the shared follower transport does — a persistent follower must survive a
   * dropped channel instead of silently discarding every response (`sendRaw`
   * no-ops while `readyState !== 'open'`) until the whole server restarts.
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    if (this.reconnectAttempts >= this.maxReconnects) {
      this.log('[electron-follower] reconnect attempts exhausted — stopping follower');
      this.stop();
      return;
    }
    const delayMs = Math.min(1000 * 2 ** this.reconnectAttempts, 15000);
    this.reconnectAttempts++;
    this.log(
      `[electron-follower] tray-control channel lost — reconnecting in ${delayMs}ms ` +
        `(attempt ${this.reconnectAttempts}/${this.maxReconnects})`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.teardownPeer();
      this.reconnecting = false;
      if (this.stopped) return;
      void this.joinOnce().catch((e) =>
        this.log(`[electron-follower] reconnect join failed: ${String(e)}`)
      );
    }, delayMs);
  }

  /** Close the WebRTC peer + CDP link and reset per-connection state so a fresh
   *  `joinOnce()` re-attaches cleanly (the tray may have superseded). Does NOT
   *  set `stopped` — that is reserved for a caller-initiated `stop()`. */
  private teardownPeer(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.cdp?.stop();
    this.cdp = null;
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    this.channel = null;
    try {
      void this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.bootstrapId = '';
    this.cursor = 0;
    this.seenEvents.clear();
  }

  private wireControlChannel(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.stateChanged.subscribe((state) => {
      if (state === 'open') {
        this.reconnectAttempts = 0;
        void this.onChannelOpen();
      } else if ((state === 'closed' || state === 'closing') && !this.stopped) {
        this.scheduleReconnect();
      }
    });
    ch.onMessage.subscribe((data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      this.dispatchRaw(text);
    });
  }

  private async onChannelOpen(): Promise<void> {
    this.log('[electron-follower] tray-control open — sending hello + targets');
    this.sendRaw({
      type: 'hello',
      protocolVersion: TRAY_SYNC_PROTOCOL_VERSION,
      runtime: FOLLOWER_RUNTIME_TAG,
    });
    const targets = await this.opts.listTargets();
    this.cdp?.advertiseTargets(targets);
  }

  /** Parse one inbound data-channel frame and route it. Transport `__chunk`
   *  frames (an oversize message the leader split below the SCTP limit — e.g. a
   *  long `Runtime.evaluate` expression) are reassembled first, then the
   *  recovered message is dispatched; ping is auto-answered; `cdp.request` is
   *  serviced by the federated-CDP servicer. */
  dispatchRaw(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (isTrayChunkFrame(message)) {
      const reassembled = this.reassembler.push(message);
      if (reassembled !== null) this.dispatchRaw(reassembled);
      return;
    }
    this.dispatchLeaderMessage(message as LeaderToFollowerMessage);
  }

  /** Pure dispatch (exposed for tests). */
  dispatchLeaderMessage(message: LeaderToFollowerMessage | { type: string }): void {
    switch (message.type) {
      case 'ping':
        this.sendRaw({ type: 'pong' });
        return;
      case 'cdp.request': {
        const req = message as Extract<LeaderToFollowerMessage, { type: 'cdp.request' }>;
        this.cdp?.handleCdpRequest({
          requestId: req.requestId,
          localTargetId: req.localTargetId,
          method: req.method,
          params: req.params,
          sessionId: req.sessionId,
        });
        return;
      }
      default:
        return;
    }
  }

  private sendToLeader(message: FollowerToLeaderMessage): void {
    this.sendRaw(message);
  }

  private sendRaw(message: unknown): void {
    const ch = this.channel;
    if (ch?.readyState !== 'open') return;
    ch.send(JSON.stringify(message));
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => void this.pollOnce(), this.opts.pollIntervalMs ?? 500);
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped || !this.bootstrapId) {
      this.schedulePoll();
      return;
    }
    try {
      const res = await this.signaling.poll(this.controllerId, this.bootstrapId, this.cursor);
      const events = Array.isArray(res['events'])
        ? (res['events'] as Array<Record<string, unknown>>)
        : [];
      for (const event of events) await this.handleBootstrapEvent(event);
      this.cursor += events.length;
    } catch (e) {
      this.log(`[electron-follower] poll failed: ${String(e)}`);
    }
    this.schedulePoll();
  }

  private async handleBootstrapEvent(event: Record<string, unknown>): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const key = JSON.stringify(event);
    if (this.seenEvents.has(key)) return;
    // Bound the de-dup set: `cursor` already gates re-delivery of consumed
    // offsets, so evicting old keys can never reprocess a stale event.
    if (this.seenEvents.size >= MAX_SEEN_EVENTS) this.seenEvents.clear();
    this.seenEvents.add(key);

    if (event['type'] === 'bootstrap.offer') {
      const offer = event['offer'] as { type: string; sdp: string } | undefined;
      if (!offer?.sdp) return;
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.signaling.sendAnswer(
        this.controllerId,
        this.bootstrapId,
        pc.localDescription!.sdp
      );
      this.log('[electron-follower] answered leader offer');
    } else if (event['type'] === 'bootstrap.ice_candidate') {
      const candidate = event['candidate'] as Record<string, unknown> | undefined;
      if (candidate) {
        try {
          await pc.addIceCandidate(candidate as RTCIceCandidateInit);
        } catch (e) {
          this.log(`[electron-follower] addIceCandidate failed: ${String(e)}`);
        }
      }
    }
  }
}

/**
 * Reassembles `TrayChunkFrame` transport frames into the original serialized
 * message. Frames of one message share a `chunkId`; `push` returns the joined
 * message once every index has arrived, else null. Bounded to
 * {@link TRAY_MAX_PENDING_REASSEMBLIES} concurrent groups (oldest evicted
 * first) so a peer can't exhaust memory with many partial reassemblies.
 * Mirrors the receive side of the webapp's `TraySyncChannel` and the shared
 * Swift/Go followers.
 */
export class ChunkReassembler {
  private readonly pending = new Map<string, { total: number; chunks: Map<number, string> }>();

  push(frame: TrayChunkFrame): string | null {
    let entry = this.pending.get(frame.chunkId);
    if (!entry) {
      if (this.pending.size >= TRAY_MAX_PENDING_REASSEMBLIES) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      entry = { total: frame.totalChunks, chunks: new Map() };
      this.pending.set(frame.chunkId, entry);
    }
    // A frame whose totalChunks disagrees with its group is malformed — ignore.
    if (frame.totalChunks !== entry.total) return null;
    entry.chunks.set(frame.chunkIndex, frame.chunkData);
    if (entry.chunks.size < entry.total) return null;
    this.pending.delete(frame.chunkId);
    let out = '';
    for (let i = 0; i < entry.total; i++) out += entry.chunks.get(i) ?? '';
    return out;
  }
}

/** Normalize the worker's ICE server list into werift's config shape. */
export function normalizeIceServers(raw: unknown): IceServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const servers: IceServerConfig[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      const urls = e['urls'] ?? e['url'];
      if (typeof urls === 'string' || Array.isArray(urls)) {
        servers.push({
          urls: urls as string | string[],
          username: typeof e['username'] === 'string' ? e['username'] : undefined,
          credential: typeof e['credential'] === 'string' ? e['credential'] : undefined,
        });
      }
    }
  }
  return servers;
}
