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
  type LeaderToFollowerMessage,
  TRAY_SYNC_PROTOCOL_VERSION,
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
    });
    if (!res.ok) throw new Error(`tray signalling ${res.status} ${res.statusText}`);
    return (await res.json()) as Record<string, unknown>;
  }

  attach(controllerId: string, runtime: string): Promise<Record<string, unknown>> {
    return this.post({ controllerId, runtime });
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

  constructor(options: ElectronTrayFollowerOptions) {
    this.opts = options as ElectronTrayFollower['opts'];
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.signaling = new TrayFollowerSignaling(options.joinUrl, this.fetchImpl);
    this.log = options.logger ?? (() => {});
  }

  /**
   * Attach to the tray, following a `TRAY_SUPERSEDED` redirect to the fresh
   * join URL (the tray mints a new one when the leader reconnects — observed
   * live). Returns the ICE servers, or null if no bootstrap could be obtained.
   */
  private async attachWithRedirects(maxHops = 4): Promise<IceServerConfig[] | null> {
    for (let hop = 0; hop < maxHops; hop++) {
      const attach = await this.signaling.attach(this.controllerId, FOLLOWER_RUNTIME_TAG);
      const result = attach['result'] as Record<string, unknown> | undefined;
      const bootstrap = result?.['bootstrap'] as { bootstrapId?: string } | undefined;
      if (bootstrap?.bootstrapId) {
        this.bootstrapId = bootstrap.bootstrapId;
        return normalizeIceServers(attach['iceServers']);
      }
      const supersededUrl = result?.['joinUrl'];
      if (result?.['code'] === 'TRAY_SUPERSEDED' && typeof supersededUrl === 'string') {
        this.log(`[electron-follower] tray superseded → following ${supersededUrl}`);
        this.signaling = new TrayFollowerSignaling(supersededUrl, this.fetchImpl);
        continue;
      }
      this.log(`[electron-follower] attach failed: ${JSON.stringify(result)}`);
      return null;
    }
    return null;
  }

  /** Join the tray, answer the leader's offer, and start servicing CDP. */
  async start(): Promise<void> {
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

    this.schedulemPoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.cdp?.stop();
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      void this.pc?.close();
    } catch {
      /* ignore */
    }
  }

  private wireControlChannel(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.stateChanged.subscribe((state) => {
      if (state === 'open') void this.onChannelOpen();
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

  /** Parse one inbound data-channel message and route it. Ping is auto-answered;
   *  `cdp.request` is serviced by the federated-CDP servicer. */
  dispatchRaw(text: string): void {
    let message: LeaderToFollowerMessage | { type: string };
    try {
      message = JSON.parse(text);
    } catch {
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

  private schedulemPoll(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => void this.pollOnce(), this.opts.pollIntervalMs ?? 500);
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped || !this.bootstrapId) {
      this.schedulemPoll();
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
    this.schedulemPoll();
  }

  private async handleBootstrapEvent(event: Record<string, unknown>): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const key = JSON.stringify(event);
    if (this.seenEvents.has(key)) return;
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
