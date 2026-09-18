import {
  COMPUTER_TRAY_MAX_FPS,
  COMPUTER_TRAY_MAX_WIDTH,
  type ComputerDescriptor,
  type ComputerFrame,
  sendComputerFrame,
  uint8ToBase64,
} from '@slicc/shared-ts';
import type { LeaderSyncContext } from './context.js';

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
}

const TRAY_FRAME_MIN_INTERVAL_MS = 1000 / COMPUTER_TRAY_MAX_FPS;

/**
 * Fans `computers.list` / `computer.frame` to full-trust followers and answers
 * `computer.watch` / `computer.unwatch`. Caps the tray stream at 2 fps / 480 px.
 * Wire-only this phase — no follower UI.
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

  removeFollower(bootstrapId: string): void {
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

  private source(): TrayComputersSource | undefined {
    return this.context.options.computers;
  }
}
