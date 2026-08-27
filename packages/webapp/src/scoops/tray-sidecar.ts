/**
 * Sidecar tray attachments — SLICC as a *client* of another SLICC leader.
 *
 * This is the in-browser port of the `slicc` Go CLI's client verbs
 * (`packages/slicc-cli/internal/tray` + `commands.go`). It dials a remote
 * leader's join URL over the same WebRTC tray-control data channel every other
 * follower uses, sends `hello`, answers `ping`, and exposes the three client
 * verbs the shell's `slicc` command drives:
 *
 *   - `prompt` — send `user_message`, stream the leader's next assistant turn
 *   - `exec`   — send `exec.request`, stream the leader's virtual-shell output
 *   - `watch`  — passively tail the leader's live agent output
 *
 * **Zero wire change.** Every frame here already exists in the canonical union
 * (`@slicc/shared-ts/tray-sync-protocol.ts`) and is already handled by the
 * leader (`scoops/tray-leader/follower-dispatch.ts`, `.../remote-exec.ts`). The
 * golden corpus and its Go / Swift mirrors are untouched.
 *
 * ## Why this is not `host join`
 *
 * `host join` is a **role switch**: `wc-tray.ts` stops the leader, releases the
 * same-origin lock, and hands this instance's whole UI to the remote leader. A
 * sidecar is *additive* — this instance keeps leading its own tray, and can hold
 * several sidecars at once. Concretely, a sidecar:
 *
 *   - never touches `TrayRoleState`, `TRAY_JOIN_STORAGE_KEY`, or
 *     `TRAY_WORKER_STORAGE_KEY`, so a reload does not resurrect it;
 *   - passes a **private** {@link FollowerTrayStatusSink}, so `host` keeps
 *     reporting this instance's real role rather than the sidecar's;
 *   - runs no `FollowerSyncManager` — no transcript takeover, no CDP target
 *     advertisement, no sprinkle controller, no theme adoption.
 *
 * ## Direction, versus `ssh`
 *
 * `ssh` is leader→follower: this instance tells a follower to run something.
 * `slicc … exec` is follower→leader: this instance asks a *remote leader* to run
 * something in its virtual shell. Two halves of the same `exec.*` wire.
 *
 * ## Trust posture
 *
 * A sidecar advertises **no** capabilities — explicitly `exec: false`. It is a
 * pure client: it can ask the remote leader to do things, and the remote leader
 * can ask it for nothing. That is the whole reason inbound `exec.request` frames
 * are dropped below rather than served.
 *
 * This module runs on the **page**: `RTCPeerConnection` does not exist in a
 * worker, so the kernel-worker `slicc` command bridges here over panel-RPC,
 * exactly as `ssh` bridges to `LeaderSyncManager.execOnRemote`.
 */

import type {
  AgentEvent,
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
  TraySyncCapabilities,
} from '@slicc/shared-ts';
import { base64ToUint8, TRAY_SYNC_PROTOCOL_VERSION } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { FollowerTrayRuntimeStatus } from './tray-follower-status.js';
import { getLeaderTrayRuntimeStatus } from './tray-leader.js';
import { TraySyncChannel } from './tray-sync-protocol.js';
import type {
  FollowerAutoReconnectHandle,
  FollowerTrayStatusSink,
  TrayDataChannelLike,
} from './tray-webrtc.js';
import { startFollowerWithAutoReconnect } from './tray-webrtc.js';

const log = createLogger('tray-sidecar');

/**
 * Runtime tag a sidecar advertises on attach + `hello`. Distinct from
 * `slicc-standalone` (a real browser follower) and from the CLI's own tag so a
 * remote leader's `host` roster shows what actually connected.
 */
export const SIDECAR_RUNTIME_TAG = 'slicc-sidecar';

/** Hard cap on concurrent sidecars — a runaway agent must not exhaust ICE. */
export const MAX_SIDECAR_ATTACHMENTS = 8;

/**
 * Cap on buffered output per verb run, in UTF-16 code units — i.e. `.length` of
 * the accumulated string, which is what actually bounds retained memory (a JS
 * string is 2 bytes per unit). Sized to mirror `MAX_REMOTE_EXEC_BYTES`.
 *
 * NOT a UTF-8 byte count: the decoded string is what we hold, and re-encoding
 * every chunk to measure it would cost more than the bound is worth.
 */
const MAX_RUN_UNITS = 4 * 1024 * 1024;

/** A sidecar advertises nothing: it serves no inbound request of any kind. */
const SIDECAR_CAPABILITIES: TraySyncCapabilities = { exec: false };

export interface SidecarAttachmentInfo {
  name: string;
  joinUrl: string;
  trayId: string | null;
  state: FollowerTrayRuntimeStatus['state'];
  attachedAt: number;
  error: string | null;
}

/** One streamed slice of a verb's output, as it arrives off the data channel. */
export interface SidecarChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface SidecarRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when the run could not complete (not when the remote command failed). */
  error?: string;
  /** True when output hit {@link MAX_RUN_UNITS} and the tail was dropped. */
  truncated?: boolean;
}

export interface SidecarRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onChunk?: (chunk: SidecarChunk) => void;
}

export interface SidecarPromptOptions extends SidecarRunOptions {
  /** Interrupt the leader's running turn instead of queueing behind it. */
  steer?: boolean;
}

export interface SidecarWatchOptions extends SidecarRunOptions {
  /** Stop after this many ms of tailing. Required — a shell command must end. */
  durationMs: number;
  /** Only render events for this scoop jid. Omitted = every scoop. */
  scoopJid?: string;
  /** Stop early once a turn completes and the leader goes back to `ready`. */
  untilIdle?: boolean;
}

/**
 * Output accumulator shared by the three verbs.
 *
 * Capped on the accumulated string's length (see {@link MAX_RUN_UNITS}), which
 * is the quantity that bounds retained memory. Truncation is sticky: once
 * tripped, later chunks are dropped rather than interleaving a partial tail
 * with a later, smaller one.
 */
class RunBuffer {
  stdout = '';
  stderr = '';
  truncated = false;
  private units = 0;

  constructor(private readonly onChunk?: (chunk: SidecarChunk) => void) {}

  push(stream: 'stdout' | 'stderr', text: string): void {
    if (this.truncated || text.length === 0) return;
    this.units += text.length;
    if (this.units > MAX_RUN_UNITS) {
      this.truncated = true;
      return;
    }
    if (stream === 'stdout') this.stdout += text;
    else this.stderr += text;
    this.onChunk?.({ stream, text });
  }

  result(exitCode: number, error?: string): SidecarRunResult {
    return {
      stdout: this.truncated ? `${this.stdout}\n[output truncated at cap]` : this.stdout,
      stderr: this.stderr,
      exitCode,
      ...(error ? { error } : {}),
      ...(this.truncated ? { truncated: true } : {}),
    };
  }
}

/**
 * A single live attachment to one remote leader.
 *
 * Reconnects are transparent to the ATTACHMENT (`startFollowerWithAutoReconnect`
 * owns the backoff and the `TRAY_SUPERSEDED` redirect) but not to a verb that
 * was in flight across one: its request died with the old data channel, so
 * `wire()` fails it explicitly. It is not re-issued — a re-sent `user_message`
 * would cost a second turn and a re-sent `exec.request` would run the command
 * twice — and it must not merely be left waiting, because a `slicc exec` with
 * no `--timeout` would then hang for 24 hours on a reply that cannot arrive.
 */
class SidecarAttachment {
  private handle: FollowerAutoReconnectHandle | null = null;
  private channel: TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<(message: LeaderToFollowerMessage) => void>();
  private readonly dropListeners = new Set<(reason: string) => void>();
  private status: FollowerTrayRuntimeStatus | null = null;
  readonly attachedAt = Date.now();
  private currentJoinUrl: string;
  /**
   * The in-flight (or settled) first connect. A second caller that finds this
   * attachment mid-dial awaits it instead of receiving a `connecting` handle —
   * see {@link SidecarRegistry.attach}.
   */
  private startPromise: Promise<void> | null = null;

  constructor(
    readonly name: string,
    joinUrl: string
  ) {
    this.currentJoinUrl = joinUrl;
  }

  /** Private status sink — deliberately NOT the instance-wide globals. */
  private readonly statusSink: FollowerTrayStatusSink = {
    get: () =>
      this.status ?? {
        state: 'inactive',
        joinUrl: this.currentJoinUrl,
        trayId: null,
        error: null,
        lastPingTime: null,
        reconnectAttempts: 0,
        attachAttempts: 0,
        lastAttachCode: null,
        connectingSince: null,
        lastError: null,
      },
    set: (next) => {
      this.status = next;
    },
  };

  get info(): SidecarAttachmentInfo {
    const status = this.statusSink.get();
    return {
      name: this.name,
      joinUrl: this.currentJoinUrl,
      trayId: status.trayId,
      state: status.state,
      attachedAt: this.attachedAt,
      error: status.error,
    };
  }

  get connected(): boolean {
    return this.channel !== null && this.statusSink.get().state === 'connected';
  }

  /**
   * Resolve once this attachment's first connect has settled — immediately if
   * it already has. Rejects with the same error `start()` rejected with, so a
   * caller that joined a doomed dial fails for the real reason.
   */
  async ready(): Promise<void> {
    await (this.startPromise ?? Promise.resolve());
  }

  /** Dial, and resolve once the first channel is open and `hello` is sent. */
  async start(timeoutMs: number): Promise<void> {
    this.startPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stop();
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s connecting to leader`));
      }, timeoutMs);

      this.handle = startFollowerWithAutoReconnect(
        {
          joinUrl: this.currentJoinUrl,
          runtime: SIDECAR_RUNTIME_TAG,
          statusSink: this.statusSink,
          onJoinUrlChanged: (next) => {
            // The remote leader minted a fresh tray. Track the replacement so
            // `slicc list` shows where we actually are, but never persist it —
            // a sidecar is deliberately not restored across a reload.
            this.currentJoinUrl = next;
          },
        },
        {
          onConnected: (connection) => {
            this.wire(connection.channel);
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          },
          onGaveUp: (lastError) => {
            this.notifyDropped(`reconnect gave up: ${lastError}`);
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.stop();
            reject(new Error(lastError));
          },
        }
      );
    });
    return await this.startPromise;
  }

  private wire(rawChannel: TrayDataChannelLike): void {
    // A second call is a RECONNECT, not a first connect.
    const isReconnect = this.channel !== null;
    this.unsubscribe?.();
    const channel = new TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage>(
      rawChannel
    );
    this.channel = channel;
    this.unsubscribe = channel.onMessage((message) => this.dispatch(message));
    channel.send({
      type: 'hello',
      protocolVersion: TRAY_SYNC_PROTOCOL_VERSION,
      runtime: SIDECAR_RUNTIME_TAG,
      capabilities: SIDECAR_CAPABILITIES,
    });
    log.info(isReconnect ? 'Sidecar reconnected' : 'Sidecar attached', { name: this.name });

    // Anything still in flight was sent on the channel that just died: the
    // leader dropped the request with it, so no reply can ever arrive. Fail
    // those verbs now rather than letting them wait out a timeout that, for a
    // `slicc exec` without `--timeout`, is 24 HOURS.
    //
    // They are deliberately NOT re-issued on the new channel: a re-sent
    // `user_message` would cost a second turn, and a re-sent `exec.request`
    // would run the command a second time. Failing loudly is the only safe
    // option — the caller can decide whether repeating it is harmless.
    //
    // Fired AFTER the new channel is live, so the attachment is already usable
    // again by the time the caller sees the failure.
    if (isReconnect) this.notifyDropped('reconnected mid-request; the reply was lost');
  }

  private dispatch(message: LeaderToFollowerMessage): void {
    // Keepalive is answered here, not by a listener: the leader's
    // `follower-registry.ts` probes every peer and tears down one that never
    // answers, so liveness must not depend on a verb being in flight.
    if (message.type === 'ping') {
      this.channel?.send({ type: 'pong' });
      return;
    }
    if (message.type === 'pong') return;
    // A sidecar advertised `exec: false`, so a well-behaved leader never sends
    // these. Reply with the same refusal a capability-less follower would, so a
    // leader that asks anyway gets a prompt error instead of a hung request.
    if (message.type === 'exec.request') {
      this.channel?.send({
        type: 'exec.response',
        requestId: message.requestId,
        exitCode: 127,
        error: 'slicc sidecar is a client-only attachment and does not accept exec',
      });
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch (err) {
        log.error('Sidecar listener threw', {
          name: this.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  send(message: FollowerToLeaderMessage): boolean {
    return this.channel?.send(message) ?? false;
  }

  onMessage(listener: (message: LeaderToFollowerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notified when the transport drops, so in-flight verbs fail fast. */
  onDropped(listener: (reason: string) => void): () => void {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  private notifyDropped(reason: string): void {
    for (const listener of [...this.dropListeners]) {
      try {
        listener(reason);
      } catch {
        // A drop notification must not mask the drop.
      }
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.channel?.close();
    this.channel = null;
    this.handle?.cancel();
    this.handle = null;
    this.notifyDropped('detached');
    this.listeners.clear();
    this.dropListeners.clear();
  }
}

/** Normalize a user-supplied join URL, rejecting anything that isn't one. */
export function parseSidecarJoinUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`join URL must be http(s): ${raw}`);
  }
  if (!url.pathname.includes('/join/')) {
    throw new Error(`not a tray join URL (expected .../join/<token>): ${raw}`);
  }
  return url;
}

/**
 * Refuse to dial our own tray.
 *
 * A self-attach is a live deadlock, not merely useless: the leader tray runs on
 * this same page thread, so `slicc <own-url> exec` would block that thread
 * waiting for a reply the thread itself has to produce. Compared on
 * origin+pathname because the hub decorates join URLs with query params.
 */
export function isOwnTrayJoinUrl(url: URL): boolean {
  const own = getLeaderTrayRuntimeStatus().session?.joinUrl;
  if (!own) return false;
  try {
    const ownUrl = new URL(own);
    return ownUrl.origin === url.origin && ownUrl.pathname === url.pathname;
  } catch {
    return false;
  }
}

/** How a verb run ended, for the caller's own cleanup (abort / signal sends). */
type VerbOutcome = 'complete' | 'abort' | 'expire' | 'dropped';

interface VerbControl {
  /** Terminal frame arrived — settle with this exit code (and optional error). */
  finish(exitCode: number, error?: string): void;
}

interface RunVerbOptions extends SidecarRunOptions {
  /**
   * Settle after this long with whatever has been buffered, exit 0 — the
   * `watch` window, which is a successful end rather than a timeout. Distinct
   * from {@link SidecarRunOptions.timeoutMs}, which is a failure (exit 124).
   */
  expireMs?: number;
}

/**
 * Drive one verb to a single settlement.
 *
 * Every outcome — terminal frame, caller abort, timeout, window expiry, or the
 * transport dropping — resolves from the SAME {@link RunBuffer}, so an
 * interrupted run still returns the output it had already streamed. (The Go CLI
 * gets this for free by writing straight to stdout; here the result is the only
 * channel, so discarding the buffer on abort would silently lose a partial
 * turn.) Every path unsubscribes exactly once.
 */
function runVerb(
  attachment: SidecarAttachment,
  options: RunVerbOptions,
  buffer: RunBuffer,
  onMessage: (message: LeaderToFollowerMessage, control: VerbControl) => void
): Promise<{ result: SidecarRunResult; outcome: VerbOutcome }> {
  return new Promise((resolve) => {
    let settled = false;
    let offMessage: (() => void) | null = null;
    let offDropped: (() => void) | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;

    const settle = (outcome: VerbOutcome, exitCode: number, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      offMessage?.();
      offDropped?.();
      if (onAbort) options.signal?.removeEventListener('abort', onAbort);
      resolve({ result: buffer.result(exitCode, error), outcome });
    };

    const control: VerbControl = {
      finish: (exitCode, error) => settle('complete', exitCode, error),
    };

    offMessage = attachment.onMessage((message) => onMessage(message, control));
    offDropped = attachment.onDropped((reason) =>
      settle('dropped', 1, `connection lost: ${reason}`)
    );

    if (options.timeoutMs !== undefined) {
      const seconds = Math.round(options.timeoutMs / 1000);
      // A timeout settles as `abort` so the caller runs the same cleanup it
      // would for Ctrl+C — tell the remote to stop, rather than leaving a turn
      // or a command running for nobody.
      timeoutTimer = setTimeout(
        () => settle('abort', 124, `timed out after ${seconds}s`),
        options.timeoutMs
      );
    }
    if (options.expireMs !== undefined) {
      expiryTimer = setTimeout(() => settle('expire', 0), options.expireMs);
    }

    if (options.signal) {
      if (options.signal.aborted) {
        settle('abort', 130, 'interrupted');
        return;
      }
      onAbort = () => settle('abort', 130, 'interrupted');
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * The page-side registry of live sidecar attachments.
 *
 * One instance per page, owned by `setup-standalone-panel-rpc.ts`. Attachments
 * are named so a shell session can reuse a warm connection across commands
 * instead of paying an ICE handshake per verb.
 */
export class SidecarRegistry {
  private readonly attachments = new Map<string, SidecarAttachment>();
  private counter = 0;

  list(): SidecarAttachmentInfo[] {
    return [...this.attachments.values()].map((a) => a.info);
  }

  /**
   * Attach to `joinUrl`, or return the existing attachment when one is already
   * live for the same URL. `name` is caller-chosen; omitted, one is generated.
   */
  async attach(opts: {
    joinUrl: string;
    name?: string;
    connectTimeoutMs?: number;
  }): Promise<SidecarAttachmentInfo> {
    const url = parseSidecarJoinUrl(opts.joinUrl);
    if (isOwnTrayJoinUrl(url)) {
      throw new Error(
        "refusing to attach to this instance's own tray — that would deadlock the leader thread"
      );
    }
    const existing = this.findByJoinUrl(url);
    if (existing) {
      // The map is populated BEFORE the dial's first await, so a concurrent
      // `attach` for the same tray lands here rather than dialing a second
      // time. Await the in-flight connect: returning a still-`connecting`
      // handle would make the caller's very next verb fail `not connected` —
      // and the agent loop runs a message's bash calls with `Promise.all`, so
      // two `slicc <same-url> exec …` in one turn is the ORDINARY case, not a
      // pathological one.
      await existing.ready();
      return existing.info;
    }
    if (this.attachments.size >= MAX_SIDECAR_ATTACHMENTS) {
      throw new Error(
        `too many sidecar attachments (${MAX_SIDECAR_ATTACHMENTS}); detach one first`
      );
    }
    const name = opts.name ?? `slicc-${++this.counter}`;
    if (this.attachments.has(name)) throw new Error(`attachment '${name}' already exists`);

    const attachment = new SidecarAttachment(name, url.toString());
    this.attachments.set(name, attachment);
    try {
      await attachment.start(opts.connectTimeoutMs ?? 30_000);
    } catch (err) {
      this.attachments.delete(name);
      throw err;
    }
    return attachment.info;
  }

  detach(name: string): boolean {
    const attachment = this.attachments.get(name);
    if (!attachment) return false;
    attachment.stop();
    this.attachments.delete(name);
    return true;
  }

  detachAll(): void {
    for (const name of [...this.attachments.keys()]) this.detach(name);
  }

  private findByJoinUrl(url: URL): SidecarAttachment | undefined {
    const key = `${url.origin}${url.pathname}`;
    return [...this.attachments.values()].find((a) => {
      try {
        const existing = new URL(a.info.joinUrl);
        return `${existing.origin}${existing.pathname}` === key;
      } catch {
        return false;
      }
    });
  }

  private require(name: string): SidecarAttachment {
    const attachment = this.attachments.get(name);
    if (!attachment) throw new Error(`no such attachment: ${name}`);
    if (!attachment.connected) throw new Error(`attachment '${name}' is not connected`);
    return attachment;
  }

  /**
   * Send one chat turn and stream the leader's reply.
   *
   * A live browser leader emits no `turn_end` — it signals turn completion by
   * `scoopStatus` going `processing` → anything else. Both endings are honored,
   * matching `cmdPrompt` in the Go CLI, because a non-live float does send
   * `turn_end` and would otherwise hang until the timeout.
   */
  async prompt(
    name: string,
    text: string,
    options: SidecarPromptOptions = {}
  ): Promise<SidecarRunResult> {
    const attachment = this.require(name);
    const buffer = new RunBuffer(options.onChunk);
    let sawProcessing = false;

    const run = runVerb(attachment, options, buffer, (message, control) => {
      if (message.type === 'agent_event') {
        const event = message.event;
        if (event.type === 'content_delta') buffer.push('stdout', event.text);
        else if (event.type === 'turn_end') control.finish(0);
        else if (event.type === 'error') {
          buffer.push('stderr', `${event.error}\n`);
          control.finish(1);
        }
        return;
      }
      if (message.type === 'status') {
        if (message.scoopStatus === 'processing') sawProcessing = true;
        else if (sawProcessing) control.finish(0);
        return;
      }
      if (message.type === 'error') {
        buffer.push('stderr', `${message.error}\n`);
        control.finish(1);
      }
    });

    const sent = attachment.send({
      type: 'user_message',
      text,
      messageId: crypto.randomUUID(),
      ...(options.steer ? { steer: true } : {}),
    });
    if (!sent) return { stdout: '', stderr: '', exitCode: 1, error: 'failed to send user_message' };

    const { result, outcome } = await run;
    // An interrupt or timeout must stop the remote turn too — otherwise the
    // leader keeps spending tokens producing output nobody is reading.
    if (outcome === 'abort') attachment.send({ type: 'abort' });
    return result;
  }

  /** Run a command in the remote leader's virtual shell (`exec.*`). */
  async exec(
    name: string,
    command: string,
    options: SidecarRunOptions & { cwd?: string; env?: Record<string, string>; stdin?: string } = {}
  ): Promise<SidecarRunResult> {
    const attachment = this.require(name);
    const requestId = crypto.randomUUID();
    const buffer = new RunBuffer(options.onChunk);
    // Streaming decoders: a chunk boundary can split a multi-byte character, so
    // each stream needs its own decoder carried across chunks.
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();

    const run = runVerb(attachment, options, buffer, (message, control) => {
      if (message.type === 'exec.chunk' && message.requestId === requestId) {
        let bytes: Uint8Array;
        try {
          bytes = base64ToUint8(message.data);
        } catch {
          return;
        }
        const decoder = message.stream === 'stdout' ? stdoutDecoder : stderrDecoder;
        buffer.push(message.stream, decoder.decode(bytes, { stream: true }));
        return;
      }
      if (message.type === 'exec.response' && message.requestId === requestId) {
        // Flush whatever the decoders are still holding before settling.
        buffer.push('stdout', stdoutDecoder.decode());
        buffer.push('stderr', stderrDecoder.decode());
        control.finish(message.exitCode, message.error);
      }
    });

    const sent = attachment.send({
      type: 'exec.request',
      requestId,
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.stdin ? { stdin: options.stdin } : {}),
    });
    if (!sent) return { stdout: '', stderr: '', exitCode: 1, error: 'failed to send exec.request' };

    const { result, outcome } = await run;
    if (outcome === 'abort') {
      attachment.send({ type: 'exec.signal', requestId, signal: 'SIGINT' });
    }
    return result;
  }

  /**
   * Passively tail the remote leader's agent output for a bounded window.
   *
   * Sends nothing — a read-only mirror, like the CLI's `watch`. Bounded because
   * a just-bash command returns ONE buffered result: there is no incremental
   * stdout to hold a `tail -f` open against, so the window has to be a
   * parameter rather than a Ctrl+C away.
   */
  async watch(name: string, options: SidecarWatchOptions): Promise<SidecarRunResult> {
    const attachment = this.require(name);
    const buffer = new RunBuffer(options.onChunk);
    let sawProcessing = false;

    const { result } = await runVerb(
      attachment,
      // The window IS the exit condition, so it expires with exit 0 rather than
      // reporting the 124 a real timeout would.
      { ...options, timeoutMs: undefined, expireMs: options.durationMs },
      buffer,
      (message, control) => {
        if (message.type === 'user_message_echo') {
          buffer.push('stdout', `\n> ${message.text}\n`);
          return;
        }
        if (message.type === 'agent_event') {
          if (options.scoopJid && message.scoopJid !== options.scoopJid) return;
          buffer.push('stdout', renderWatchEvent(message.event));
          return;
        }
        if (message.type === 'status') {
          if (options.scoopJid && message.scoopJid !== options.scoopJid) return;
          if (message.scoopStatus === 'processing') sawProcessing = true;
          else if (sawProcessing && options.untilIdle) control.finish(0);
          return;
        }
        if (message.type === 'error') buffer.push('stderr', `${message.error}\n`);
      }
    );
    return result;
  }
}

/** One line per agent event, mirroring the CLI's `printWatchEvent` render map. */
function renderWatchEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'content_delta':
      return event.text;
    case 'tool_use_start':
      return `\n[tool] ${event.toolName} ${compactArgs(event.toolInput)}\n`;
    case 'tool_result':
      return `[${event.isError ? 'tool-error' : 'tool-ok'}] ${truncateOneLine(event.result, 200)}\n`;
    case 'turn_end':
      return '\n';
    case 'error':
      return `[error] ${event.error}\n`;
    default:
      // Unknown / unrendered event kinds are silently skipped, exactly as the
      // Go CLI does — a new wire event must not spray noise into a tail.
      return '';
  }
}

function compactArgs(input: unknown): string {
  if (input === undefined || input === null) return '';
  try {
    return truncateOneLine(JSON.stringify(input), 120);
  } catch {
    return '';
  }
}

function truncateOneLine(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}
