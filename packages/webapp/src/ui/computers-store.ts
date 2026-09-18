/**
 * Page-side store for `computers` / `computer-frame` kernel messages.
 *
 * Overlay cards, the live lightbox, and bash-row renderers subscribe here.
 * Watch is refcounted so overlay, a live bash row, and the lightbox can
 * share one kernel subscription without unwatching each other. Each
 * subscriber keeps its own fps/maxWidth; the kernel is sent the max of
 * the live set and is re-sent when that max changes.
 */

import type { ComputerDescriptor, ComputerFrame, ComputerInputEvent } from '@slicc/shared-ts';
import { coerceComputerFrameBytes } from '../computers/frame-bytes.js';
import type {
  ComputerFrameMsg,
  ComputerPageControlMsg,
  ComputersListMsg,
} from '../kernel/messages.js';

export type ComputersStoreListener = (computers: ComputerDescriptor[]) => void;
export type ComputerFrameListener = (id: string, frame: ComputerFrame) => void;
export type ComputerInvocationListener = () => void;
export type ComputersStoreSender = (msg: ComputerPageControlMsg) => void;

const DEFAULT_WATCH_FPS = 2;
const DEFAULT_WATCH_MAX_WIDTH = 768;

interface WatchSubscription {
  token: number;
  fps: number;
  maxWidth: number;
}

class ComputersStore {
  private computers: ComputerDescriptor[] = [];
  private readonly frames = new Map<string, ComputerFrame>();
  private readonly listListeners = new Set<ComputersStoreListener>();
  private readonly frameListeners = new Set<ComputerFrameListener>();
  private readonly invocationListeners = new Set<ComputerInvocationListener>();
  private sender: ComputersStoreSender | null = null;
  private readonly watchSubs = new Map<string, WatchSubscription[]>();
  private readonly kernelWatch = new Map<string, { fps: number; maxWidth: number }>();
  private nextWatchToken = 1;
  /** Newest `computer` bash-row tool-call id per computer. */
  private readonly invocations = new Map<string, string>();

  list(): ComputerDescriptor[] {
    return this.computers.slice();
  }

  get(id: string): ComputerDescriptor | null {
    return this.computers.find((c) => c.id === id) ?? null;
  }

  lastFrame(id: string): ComputerFrame | null {
    return this.frames.get(id) ?? null;
  }

  onList(listener: ComputersStoreListener): () => void {
    this.listListeners.add(listener);
    return () => this.listListeners.delete(listener);
  }

  onFrame(listener: ComputerFrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onInvocations(listener: ComputerInvocationListener): () => void {
    this.invocationListeners.add(listener);
    return () => this.invocationListeners.delete(listener);
  }

  setSender(sender: ComputersStoreSender | null): void {
    this.sender = sender;
  }

  isWatching(id: string): boolean {
    return (this.watchSubs.get(id)?.length ?? 0) > 0;
  }

  watchRefCount(id: string): number {
    return this.watchSubs.get(id)?.length ?? 0;
  }

  watch(id: string, fps = DEFAULT_WATCH_FPS, maxWidth = DEFAULT_WATCH_MAX_WIDTH): number {
    if (!this.sender) throw new Error('computers store has no kernel sender');
    const token = this.nextWatchToken++;
    const subs = this.watchSubs.get(id) ?? [];
    subs.push({ token, fps, maxWidth });
    this.watchSubs.set(id, subs);
    this.syncKernelWatch(id);
    return token;
  }

  unwatch(id: string, token?: number): void {
    if (!this.sender) throw new Error('computers store has no kernel sender');
    const subs = this.watchSubs.get(id);
    if (!subs?.length) return;
    const index = token === undefined ? subs.length - 1 : subs.findIndex((s) => s.token === token);
    if (index < 0) return;
    subs.splice(index, 1);
    if (subs.length === 0) {
      this.watchSubs.delete(id);
      this.kernelWatch.delete(id);
      this.sender({ type: 'computer-unwatch', id });
      return;
    }
    this.syncKernelWatch(id);
  }

  private syncKernelWatch(id: string): void {
    const subs = this.watchSubs.get(id);
    if (!subs?.length || !this.sender) return;
    const fps = Math.max(...subs.map((s) => s.fps));
    const maxWidth = Math.max(...subs.map((s) => s.maxWidth));
    const prev = this.kernelWatch.get(id);
    if (prev && prev.fps === fps && prev.maxWidth === maxWidth) return;
    this.kernelWatch.set(id, { fps, maxWidth });
    this.sender({ type: 'computer-watch', id, fps, maxWidth });
  }

  input(id: string, events: ComputerInputEvent[]): void {
    if (!this.sender) throw new Error('computers store has no kernel sender');
    this.sender({ type: 'computer-input', id, events });
  }

  recordInvocation(computerId: string, toolCallId: string): void {
    this.invocations.set(computerId, toolCallId);
    for (const listener of [...this.invocationListeners]) listener();
  }

  newestInvocation(computerId: string): string | null {
    return this.invocations.get(computerId) ?? null;
  }

  applyList(msg: ComputersListMsg): void {
    this.computers = msg.computers.slice();
    const live = new Set(this.computers.map((c) => c.id));
    for (const id of [...this.invocations.keys()]) {
      if (!live.has(id)) this.invocations.delete(id);
    }
    for (const listener of [...this.listListeners]) listener(this.computers);
  }

  applyFrame(msg: ComputerFrameMsg): void {
    const frame: ComputerFrame = {
      seq: msg.seq,
      mime: msg.mime,
      width: msg.width,
      height: msg.height,
      bytes: coerceComputerFrameBytes(msg.bytes),
      ...(msg.overCap ? { overCap: true } : {}),
    };
    this.frames.set(msg.id, frame);
    for (const listener of [...this.frameListeners]) listener(msg.id, frame);
  }
}

let store: ComputersStore | null = null;

export function getComputersStore(): ComputersStore {
  if (!store) store = new ComputersStore();
  return store;
}

export function resetComputersStoreForTests(): void {
  store = new ComputersStore();
}
