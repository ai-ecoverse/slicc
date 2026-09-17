/**
 * Page-side stub that receives `computers` / `computer-frame` kernel
 * messages. Phase 2 UI (overlay cards, lightbox) will subscribe here;
 * phase 1 only needs a sink so the wire is exercised.
 */

import type { ComputerDescriptor, ComputerFrame } from '@slicc/shared-ts';
import type { ComputerFrameMsg, ComputersListMsg } from '../kernel/messages.js';

export type ComputersStoreListener = (computers: ComputerDescriptor[]) => void;
export type ComputerFrameListener = (id: string, frame: ComputerFrame) => void;

class ComputersStore {
  private computers: ComputerDescriptor[] = [];
  private readonly frames = new Map<string, ComputerFrame>();
  private readonly listListeners = new Set<ComputersStoreListener>();
  private readonly frameListeners = new Set<ComputerFrameListener>();

  list(): ComputerDescriptor[] {
    return this.computers.slice();
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

  applyList(msg: ComputersListMsg): void {
    this.computers = msg.computers.slice();
    for (const listener of [...this.listListeners]) listener(this.computers);
  }

  applyFrame(msg: ComputerFrameMsg): void {
    const frame: ComputerFrame = {
      seq: msg.seq,
      mime: msg.mime,
      width: msg.width,
      height: msg.height,
      bytes: msg.bytes,
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
