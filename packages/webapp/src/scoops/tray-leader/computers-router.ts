import {
  COMPUTER_TRAY_MAX_FPS,
  COMPUTER_TRAY_MAX_WIDTH,
  type ComputerDescriptor,
  type ComputerFrame,
  type ComputerInputEvent,
  type ComputerNativeFrameBuffer,
  type ComputerNativeFrameMessage,
  type FollowerToLeaderMessage,
  reassembleComputerNativeFrame,
  sendComputerFrame,
  uint8ToBase64,
} from '@slicc/shared-ts';
import type { LeaderSyncContext } from './context.js';

export interface NativeComputerCaptureResult {
  jpeg: string;
  mime: string;
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
}

/**
 * Page-side computer roster the tray leader can subscribe to. Filled from
 * `getComputersStore()` in `page-leader-tray.ts` so this scoops/ module never
 * imports ui/.
 */
export interface TrayComputersSource {
  list(): ComputerDescriptor[];
  onList(listener: (computers: ComputerDescriptor[]) => void): () => void;
  onFrame(listener: (id: string, frame: ComputerFrame) => void): () => void;
  lastFrame(id: string): ComputerFrame | null;
  watch(id: string, fps?: number, maxWidth?: number): number;
  unwatch(id: string, token?: number): void;
  /** Drive a computer from a follower (iOS soft keys). */
  input?(id: string, events: ComputerInputEvent[]): Promise<void> | void;
}

const TRAY_FRAME_MIN_INTERVAL_MS = 1000 / COMPUTER_TRAY_MAX_FPS;

type NativeFanoutMessage = Extract<
  FollowerToLeaderMessage,
  { type: 'computer.native.frame' | 'computer.native.error' }
>;

type NativeWireMessage = Extract<
  FollowerToLeaderMessage,
  {
    type: 'computer.native.frame' | 'computer.native.error' | 'computer.native.input.result';
  }
>;

/**
 * Fans `computers.list` / `computer.frame` to full-trust followers and answers
 * `computer.watch` / `computer.unwatch` / `computer.input`. Caps the tray
 * stream at 2 fps / 480 px. Native capture frames fan out via `onNative`; a
 * `watch: true` capture also feeds its own per-request `onFrame` sink, which is
 * how the `ssh` adapter consumes a live `SCStream` instead of polling (#3386).
 */
export class ComputersRouter {
  /** Computer ids each follower is watching. */
  private readonly watches = new Map<string, Set<string>>();
  /** Followers currently watching a given computer (drives store.watch). */
  private readonly storeWatchRefs = new Map<string, number>();
  /** Token from the single store.watch shared by all tray followers. */
  private readonly storeWatchTokens = new Map<string, number>();
  /** Last successful frame send per follower+computer, for the 2 fps cap. */
  private readonly lastSentAt = new Map<string, number>();
  private readonly nativeListeners = new Set<
    (bootstrapId: string, message: NativeFanoutMessage) => void
  >();
  private readonly nativeChunks = new Map<string, ComputerNativeFrameBuffer>();
  private readonly pendingNative = new Map<
    string,
    {
      resolve: (frame: NativeComputerCaptureResult) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly pendingInput = new Map<
    string,
    {
      resolve: () => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /**
   * Live `watch: true` captures. The follower reuses one requestId for every
   * frame of a stream, so this outlives the `pendingNative` slot the first
   * frame settles.
   */
  private readonly nativeWatches = new Map<
    string,
    { runtimeId: string; onFrame: (frame: NativeComputerCaptureResult) => void }
  >();
  private unsubList: (() => void) | null = null;
  private unsubFrame: (() => void) | null = null;

  constructor(private readonly context: LeaderSyncContext) {}

  start(): void {
    const src = this.source();
    if (!src || this.unsubList) return;
    this.unsubList = src.onList((computers) => this.onListChanged(computers));
    this.unsubFrame = src.onFrame((id, frame) => this.fanOutFrame(id, frame));
  }

  sendListToFollower(bootstrapId: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower || follower.trust === 'biscotto') return;
    const src = this.source();
    if (!src) return;
    try {
      follower.sync.send({ type: 'computers.list', computers: src.list() });
    } catch (err) {
      this.context.log.warn('Failed to send computers.list', {
        bootstrapId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  handleWatch(bootstrapId: string, id: string, _fps?: number, _maxWidth?: number): void {
    const src = this.source();
    if (!src) return;
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower || follower.trust === 'biscotto') return;
    const ids = this.watches.get(bootstrapId) ?? new Set<string>();
    if (ids.has(id)) return;
    ids.add(id);
    this.watches.set(bootstrapId, ids);
    const n = (this.storeWatchRefs.get(id) ?? 0) + 1;
    this.storeWatchRefs.set(id, n);
    if (n === 1) {
      try {
        this.storeWatchTokens.set(
          id,
          src.watch(id, COMPUTER_TRAY_MAX_FPS, COMPUTER_TRAY_MAX_WIDTH)
        );
      } catch (err) {
        this.context.log.warn('computer.watch failed', {
          bootstrapId,
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const last = src.lastFrame(id);
    if (last) this.sendFrame(bootstrapId, id, last, true);
  }

  handleUnwatch(bootstrapId: string, id: string): void {
    const ids = this.watches.get(bootstrapId);
    if (!ids?.has(id)) return;
    ids.delete(id);
    if (ids.size === 0) this.watches.delete(bootstrapId);
    this.lastSentAt.delete(this.frameKey(bootstrapId, id));
    const n = (this.storeWatchRefs.get(id) ?? 0) - 1;
    if (n > 0) {
      this.storeWatchRefs.set(id, n);
      return;
    }
    this.storeWatchRefs.delete(id);
    const token = this.storeWatchTokens.get(id);
    this.storeWatchTokens.delete(id);
    const src = this.source();
    if (!src) return;
    try {
      src.unwatch(id, token);
    } catch (err) {
      this.context.log.warn('computer.unwatch failed', {
        bootstrapId,
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  handleInput(bootstrapId: string, id: string, events: ComputerInputEvent[]): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower || follower.trust === 'biscotto') return;
    const src = this.source();
    if (!src?.input) {
      this.context.log.warn('computer.input dropped — no store handler', { bootstrapId, id });
      return;
    }
    void Promise.resolve(src.input(id, events)).catch((err: unknown) => {
      this.context.log.warn('computer.input failed', {
        bootstrapId,
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async captureNative(
    runtimeId: string,
    opts: {
      fps?: number;
      maxWidth?: number;
      /** 1-based OS display index on the follower; omitted means its main display. */
      display?: number;
      watch?: boolean;
      timeoutMs?: number;
      /**
       * Sink for a `watch: true` stream — called for EVERY frame, the first
       * one included. Ignored for a one-shot capture.
       */
      onFrame?: (frame: NativeComputerCaptureResult) => void;
    } = {}
  ): Promise<NativeComputerCaptureResult> {
    const follower = this.requireComputerFollower(runtimeId);
    const requestId = `ncap-${crypto.randomUUID()}`;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    if (opts.watch && opts.onFrame) {
      this.nativeWatches.set(requestId, { runtimeId, onFrame: opts.onFrame });
    }
    return await new Promise<NativeComputerCaptureResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNative.delete(requestId);
        this.nativeWatches.delete(requestId);
        reject(new Error(`computer.native.capture timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingNative.set(requestId, { resolve, reject, timer });
      const sent = follower.sync.send({
        type: 'computer.native.capture',
        requestId,
        fps: opts.fps,
        maxWidth: opts.maxWidth,
        display: opts.display,
        watch: opts.watch ?? false,
      });
      if (!sent) {
        this.pendingNative.delete(requestId);
        this.nativeWatches.delete(requestId);
        clearTimeout(timer);
        reject(new Error(`Failed to send computer.native.capture to '${runtimeId}'`));
      }
    });
  }

  async inputNative(
    runtimeId: string,
    events: ComputerInputEvent[],
    opts: {
      timeoutMs?: number;
      /** The capture's display index, so the follower maps through that screen. */
      display?: number;
    } = {}
  ): Promise<void> {
    const follower = this.requireComputerFollower(runtimeId);
    const requestId = `nin-${crypto.randomUUID()}`;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInput.delete(requestId);
        reject(new Error(`computer.native.input timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingInput.set(requestId, { resolve, reject, timer });
      const sent = follower.sync.send({
        type: 'computer.native.input',
        requestId,
        events,
        display: opts.display,
      });
      if (!sent) {
        this.pendingInput.delete(requestId);
        clearTimeout(timer);
        reject(new Error(`Failed to send computer.native.input to '${runtimeId}'`));
      }
    });
  }

  unwatchNative(runtimeId: string): void {
    // Drop the sink FIRST: a follower that dropped off makes
    // `requireComputerFollower` throw, and a stale sink would then outlive the
    // stream it belongs to.
    for (const [requestId, watch] of this.nativeWatches) {
      if (watch.runtimeId === runtimeId) this.nativeWatches.delete(requestId);
    }
    const follower = this.requireComputerFollower(runtimeId);
    follower.sync.send({ type: 'computer.native.unwatch' });
  }

  handleNative(bootstrapId: string, message: NativeWireMessage): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower || follower.trust === 'biscotto') return;
    if (message.type === 'computer.native.input.result') {
      this.settleNativeInput(message.requestId, message.error);
      return;
    }
    if (message.type === 'computer.native.error') {
      this.settleNativeInput(message.requestId, message.error);
    }
    this.settleNative(message);
    this.nativeListeners.forEach((listener) => {
      try {
        listener(bootstrapId, message);
      } catch (err) {
        this.context.log.warn('computer.native listener failed', {
          bootstrapId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  onNative(listener: (bootstrapId: string, message: NativeFanoutMessage) => void): () => void {
    this.nativeListeners.add(listener);
    return () => {
      this.nativeListeners.delete(listener);
    };
  }

  removeFollower(bootstrapId: string): void {
    this.nativeChunks.clear();
    const ids = this.watches.get(bootstrapId);
    if (!ids) return;
    for (const id of [...ids]) this.handleUnwatch(bootstrapId, id);
  }

  private onListChanged(computers: ComputerDescriptor[]): void {
    const live = new Set(computers.map((c) => c.id));
    for (const [bootstrapId, ids] of this.watches) {
      for (const id of [...ids]) {
        if (!live.has(id)) this.handleUnwatch(bootstrapId, id);
      }
    }
    this.context.followers.broadcastToAllFollowers({
      type: 'computers.list',
      computers,
    });
  }

  private fanOutFrame(id: string, frame: ComputerFrame): void {
    for (const [bootstrapId, ids] of this.watches) {
      if (ids.has(id)) this.sendFrame(bootstrapId, id, frame, false);
    }
  }

  private sendFrame(bootstrapId: string, id: string, frame: ComputerFrame, force: boolean): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower || follower.trust === 'biscotto') return;
    const key = this.frameKey(bootstrapId, id);
    const now = Date.now();
    if (!force) {
      const last = this.lastSentAt.get(key) ?? 0;
      if (now - last < TRAY_FRAME_MIN_INTERVAL_MS) return;
    }
    const ok = sendComputerFrame(follower.sync, {
      id,
      seq: frame.seq,
      mime: frame.mime,
      width: frame.width,
      height: frame.height,
      data: uint8ToBase64(frame.bytes),
    });
    if (ok) this.lastSentAt.set(key, now);
  }

  private frameKey(bootstrapId: string, id: string): string {
    return `${bootstrapId}:${id}`;
  }

  private requireComputerFollower(runtimeId: string) {
    const resolved = this.context.followers.resolveFollowerByRuntimeId(runtimeId);
    if (!resolved) throw new Error(`No connected follower for '${runtimeId}'`);
    if (resolved.follower.trust === 'biscotto') {
      throw new Error(`Follower '${runtimeId}' cannot drive computer.native.*`);
    }
    // `slicc follow --computer` names the CLI, which runs with CGO disabled and
    // captures nothing itself; the Sliccstart it spawned holds the screen. Hop
    // to that partner so the agent addresses one machine by one id (#3260).
    const target = this.pairedComputerFollower(resolved.bootstrapId) ?? resolved.follower;
    if (target.peerCapabilities?.computer !== true) {
      throw new Error(`Follower '${runtimeId}' does not advertise computer capture`);
    }
    return target;
  }

  /** The launcher folded into `bootstrapId`, when one is connected. */
  private pairedComputerFollower(bootstrapId: string) {
    const partnerId = this.context.followers.resolveComputerBootstrapId(bootstrapId);
    if (partnerId === bootstrapId) return null;
    const partner = this.context.followers.followers.get(partnerId);
    return partner?.trust === 'biscotto' ? null : (partner ?? null);
  }

  private settleNativeInput(requestId: string, error?: string): void {
    const pending = this.pendingInput.get(requestId);
    if (!pending) return;
    this.pendingInput.delete(requestId);
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(error));
    else pending.resolve();
  }

  private settleNative(message: NativeFanoutMessage): void {
    if (message.type === 'computer.native.error') {
      this.nativeWatches.delete(message.requestId);
      const pending = this.pendingNative.get(message.requestId);
      if (!pending) return;
      this.pendingNative.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.reject(new Error(message.error));
      return;
    }
    const assembled = reassembleComputerNativeFrame(
      this.nativeChunks,
      message as ComputerNativeFrameMessage
    );
    if (!assembled?.data) return;
    const frame: NativeComputerCaptureResult = {
      jpeg: assembled.data,
      mime: assembled.mime,
      width: assembled.width,
      height: assembled.height,
      nativeWidth: assembled.nativeWidth,
      nativeHeight: assembled.nativeHeight,
    };
    const watch = this.nativeWatches.get(assembled.requestId);
    if (watch) {
      try {
        watch.onFrame(frame);
      } catch (err) {
        this.context.log.warn('computer.native watch sink failed', {
          runtimeId: watch.runtimeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const pending = this.pendingNative.get(assembled.requestId);
    if (!pending) return;
    this.pendingNative.delete(assembled.requestId);
    clearTimeout(pending.timer);
    pending.resolve(frame);
  }

  private source(): TrayComputersSource | undefined {
    return this.context.options.computers;
  }
}
