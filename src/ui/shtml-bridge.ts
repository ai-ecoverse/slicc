/**
 * SHTML Bridge — API available to `.shtml` panel scripts for
 * communicating with the agent via lick events.
 */

import type { VirtualFS } from '../fs/index.js';
import type { LickEvent } from '../scoops/lick-manager.js';

export interface ShtmlBridgeAPI {
  /** Send a lick event to the agent */
  lick(event: { action: string; data?: unknown }): void;
  /** Listen for updates from the agent */
  on(event: 'update', callback: (data: unknown) => void): void;
  /** Remove an update listener */
  off(event: 'update', callback: (data: unknown) => void): void;
  /** Read a file from VFS */
  readFile(path: string): Promise<string>;
  /** Close this panel */
  close(): void;
  /** Panel name */
  readonly name: string;
}

type UpdateCallback = (data: unknown) => void;

export class ShtmlBridge {
  private listeners = new Map<string, Set<UpdateCallback>>();
  private lickHandler: (event: LickEvent) => void;
  private fs: VirtualFS;
  private closeHandler: (name: string) => void;

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent) => void,
    closeHandler: (name: string) => void,
  ) {
    this.fs = fs;
    this.lickHandler = lickHandler;
    this.closeHandler = closeHandler;
  }

  /** Create a bridge API for a specific panel. */
  createAPI(panelName: string): ShtmlBridgeAPI {
    return {
      name: panelName,
      lick: (event: { action: string; data?: unknown }) => {
        const lickEvent: LickEvent = {
          type: 'panel',
          panelName,
          targetScoop: undefined,
          timestamp: new Date().toISOString(),
          body: { action: event.action, data: event.data },
        };
        this.lickHandler(lickEvent);
      },
      on: (event: string, callback: UpdateCallback) => {
        const key = `${panelName}:${event}`;
        let set = this.listeners.get(key);
        if (!set) { set = new Set(); this.listeners.set(key, set); }
        set.add(callback);
      },
      off: (event: string, callback: UpdateCallback) => {
        const key = `${panelName}:${event}`;
        this.listeners.get(key)?.delete(callback);
      },
      readFile: async (path: string) => await this.fs.readFile(path, { encoding: 'utf-8' }) as string,
      close: () => this.closeHandler(panelName),
    };
  }

  /** Push data to a panel's update listeners. */
  pushUpdate(panelName: string, data: unknown): void {
    const key = `${panelName}:update`;
    const set = this.listeners.get(key);
    if (set) {
      for (const cb of set) {
        try { cb(data); } catch { /* ignore listener errors */ }
      }
    }
  }

  /** Clean up listeners for a panel. */
  removePanel(panelName: string): void {
    for (const key of this.listeners.keys()) {
      if (key.startsWith(`${panelName}:`)) {
        this.listeners.delete(key);
      }
    }
  }
}
