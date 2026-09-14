import { randomUUID } from 'node:crypto';
import {
  type FollowerBootstrapRequest,
  type FollowerToLeaderMessage,
  isTrayChunkFrame,
  type LeaderToFollowerMessage,
  successorVersionFromLinkHeader,
  TRAY_MAX_PENDING_REASSEMBLIES,
  TRAY_SYNC_PROTOCOL_VERSION,
  type TrayChunkFrame,
  type TrayIceCandidate,
} from '@slicc/shared-ts';

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

export const TRAY_CONTROL_CHANNEL_LABEL = 'tray-control';

export const FOLLOWER_RUNTIME_TAG = 'slicc-electron';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SIGNALLING_TIMEOUT_MS = 10_000;

const MAX_SEEN_EVENTS = 512;

export function redirectLocation(status: number, location: string | null): string | null {
  if (status < 300 || status >= 400 || !location) return null;
  try {
    const url = new URL(location);
    url.searchParams.delete('json');
    return url.toString();
  } catch {
    return null;
  }
}

interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface TraySignalingReply {
  result?: TrayAttachResultReply;
  iceServers?: unknown;
  events?: unknown;
}

interface TrayAttachResultReply {
  action?: unknown;
  code?: unknown;
  retryAfterMs?: unknown;
  joinUrl?: unknown;
  bootstrap?: { bootstrapId?: string };
}

interface BootstrapEventReply {
  type?: unknown;
  offer?: { type: string; sdp: string };
  candidate?: TrayIceCandidate;
}

interface UnverifiedIceServer {
  urls?: unknown;
  url?: unknown;
  username?: unknown;
  credential?: unknown;
}

export class TrayFollowerSignaling {
  constructor(
    private readonly joinUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async post(body: FollowerBootstrapRequest): Promise<TraySignalingReply> {
    const res = await this.fetchImpl(this.joinUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SIGNALLING_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`tray signalling ${res.status} ${res.statusText}`);
    return (await res.json()) as TraySignalingReply;
  }

  async attach(
    controllerId: string,
    runtime: string
  ): Promise<{
    status: number;
    body: TraySignalingReply;
    supersededByJoinUrl: string | null;
  }> {
    const res = await this.fetchImpl(this.joinUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId, runtime }),
      redirect: 'manual',
      signal: AbortSignal.timeout(SIGNALLING_TIMEOUT_MS),
    });
    let body: TraySignalingReply = {};
    try {
      body = (await res.json()) as TraySignalingReply;
    } catch {}
    return {
      status: res.status,
      body,

      supersededByJoinUrl:
        successorVersionFromLinkHeader(res.headers.get('Link')) ??
        redirectLocation(res.status, res.headers.get('Location')),
    };
  }
  poll(controllerId: string, bootstrapId: string, cursor: number): Promise<TraySignalingReply> {
    return this.post({ action: 'poll', controllerId, bootstrapId, cursor });
  }
  sendAnswer(controllerId: string, bootstrapId: string, sdp: string): Promise<TraySignalingReply> {
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
    candidate: TrayIceCandidate
  ): Promise<TraySignalingReply> {
    return this.post({ action: 'ice-candidate', controllerId, bootstrapId, candidate });
  }
}

export interface ElectronTrayFollowerOptions {
  joinUrl: string;

  browserWsUrl: string;

  listTargets: () => Promise<FederatedCdpInspectableTarget[]>;

  runtimeId?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  logger?: (message: string) => void;
}

export class ElectronTrayFollower {
  private readonly opts: Required<
    Pick<ElectronTrayFollowerOptions, 'joinUrl' | 'browserWsUrl' | 'listTargets'>
  > &
    ElectronTrayFollowerOptions;
  private readonly runtimeId: string;
  private readonly controllerId = randomUUID();

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

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private readonly maxReconnects = 10;

  private readonly reassembler = new ChunkReassembler();

  constructor(options: ElectronTrayFollowerOptions) {
    this.opts = options as ElectronTrayFollower['opts'];
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.signaling = new TrayFollowerSignaling(options.joinUrl, this.fetchImpl);
    this.log = options.logger ?? (() => {});
  }

  async attachWithRedirects(maxHops = 4, maxWaits = 30): Promise<IceServerConfig[] | null> {
    let hops = 0;
    let waits = 0;
    while (!this.stopped) {
      const { body, supersededByJoinUrl } = await this.signaling.attach(
        this.controllerId,
        FOLLOWER_RUNTIME_TAG
      );
      const result = body['result'];

      const bodyJoinUrl = result?.['joinUrl'];
      const supersededUrl =
        supersededByJoinUrl ??
        (result?.['code'] === 'TRAY_SUPERSEDED' && typeof bodyJoinUrl === 'string'
          ? bodyJoinUrl
          : undefined);
      if (typeof supersededUrl === 'string') {
        if (++hops > maxHops) {
          this.log('[electron-follower] too many supersede hops — giving up');
          return null;
        }
        this.log(`[electron-follower] tray superseded → following ${supersededUrl}`);
        this.signaling = new TrayFollowerSignaling(supersededUrl, this.fetchImpl);
        continue;
      }
      const bootstrap = result?.['bootstrap'] as { bootstrapId?: string } | undefined;
      if (bootstrap?.bootstrapId) {
        this.bootstrapId = bootstrap.bootstrapId;
        return normalizeIceServers(body['iceServers']);
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

  async start(): Promise<void> {
    await this.joinOnce();
  }

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
        .sendIceCandidate(this.controllerId, this.bootstrapId, cand.toJSON() as TrayIceCandidate)
        .catch((e) => this.log(`[electron-follower] sendIce failed: ${String(e)}`));
    });
    pc.onDataChannel.subscribe((ch: RTCDataChannel) => {
      if (ch.label === TRAY_CONTROL_CHANNEL_LABEL) this.wireControlChannel(ch);
    });

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

  private teardownPeer(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.cdp?.stop();
    this.cdp = null;
    try {
      this.channel?.close();
    } catch {}
    this.channel = null;
    try {
      void this.pc?.close();
    } catch {}
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
      const events = Array.isArray(res['events']) ? (res['events'] as BootstrapEventReply[]) : [];
      for (const event of events) await this.handleBootstrapEvent(event);
      this.cursor += events.length;
    } catch (e) {
      this.log(`[electron-follower] poll failed: ${String(e)}`);
    }
    this.schedulePoll();
  }

  private async handleBootstrapEvent(event: BootstrapEventReply): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const key = JSON.stringify(event);
    if (this.seenEvents.has(key)) return;

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
      const candidate = event['candidate'];
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

    if (frame.totalChunks !== entry.total) return null;
    entry.chunks.set(frame.chunkIndex, frame.chunkData);
    if (entry.chunks.size < entry.total) return null;
    this.pending.delete(frame.chunkId);
    let out = '';
    for (let i = 0; i < entry.total; i++) out += entry.chunks.get(i) ?? '';
    return out;
  }
}

export function normalizeIceServers(raw: unknown): IceServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const servers: IceServerConfig[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const e = entry as UnverifiedIceServer;
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
