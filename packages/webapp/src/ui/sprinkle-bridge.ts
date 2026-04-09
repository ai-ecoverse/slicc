/**
 * Sprinkle Bridge — API available to `.shtml` sprinkle scripts for
 * communicating with the agent via lick events.
 */

import type { VirtualFS } from '../fs/index.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import { toPreviewUrl } from '../shell/supplemental-commands/shared.js';

export interface SprinkleBridgeAPI {
  /** Send a lick event to the agent. Accepts {action, data} or a plain action string. */
  lick(event: { action: string; data?: unknown } | string): void;
  /** Listen for updates from the agent */
  on(event: 'update', callback: (data: unknown) => void): void;
  /** Remove an update listener */
  off(event: 'update', callback: (data: unknown) => void): void;
  /** Read a file from VFS */
  readFile(path: string): Promise<string>;
  /** Write text content to a VFS file */
  writeFile(path: string, content: string): Promise<void>;
  /** List directory entries */
  readDir(path: string): Promise<Array<{ name: string; type: string }>>;
  /** Check if a path exists */
  exists(path: string): Promise<boolean>;
  /** Get file/directory metadata */
  stat(path: string): Promise<{ type: string; size: number }>;
  /** Create a directory (recursive) */
  mkdir(path: string): Promise<void>;
  /** Remove a file */
  rm(path: string): Promise<void>;
  /** Capture sprinkle DOM as base64 PNG data URL */
  screenshot(selector?: string): Promise<string>;
  /** Persist sprinkle state (survives side panel close/reopen). */
  setState(data: unknown): void;
  /** Read persisted sprinkle state (null if none saved). */
  getState(): unknown;
  /** Open a VFS file in a browser tab via the preview service worker. */
  open(path: string, opts?: { projectRoot?: string }): void;
  /** Close this sprinkle */
  close(): void;
  /** Sprinkle name */
  readonly name: string;
}

type UpdateCallback = (data: unknown) => void;

export class SprinkleBridge {
  private listeners = new Map<string, Set<UpdateCallback>>();
  private lickHandler: (event: LickEvent) => void;
  private fs: VirtualFS;
  private closeHandler: (name: string) => void;

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent) => void,
    closeHandler: (name: string) => void
  ) {
    this.fs = fs;
    this.lickHandler = lickHandler;
    this.closeHandler = closeHandler;
  }

  /** Create a bridge API for a specific sprinkle. */
  createAPI(sprinkleName: string): SprinkleBridgeAPI {
    return {
      name: sprinkleName,
      lick: (event: { action: string; data?: unknown } | string) => {
        const action = typeof event === 'string' ? event : event.action;
        const data = typeof event === 'string' ? undefined : event.data;
        const lickEvent: LickEvent = {
          type: 'sprinkle',
          sprinkleName,
          targetScoop: undefined,
          timestamp: new Date().toISOString(),
          body: { action, data },
        };
        this.lickHandler(lickEvent);
      },
      on: (event: string, callback: UpdateCallback) => {
        const key = `${sprinkleName}:${event}`;
        let set = this.listeners.get(key);
        if (!set) {
          set = new Set();
          this.listeners.set(key, set);
        }
        set.add(callback);
      },
      off: (event: string, callback: UpdateCallback) => {
        const key = `${sprinkleName}:${event}`;
        this.listeners.get(key)?.delete(callback);
      },
      readFile: async (path: string) =>
        (await this.fs.readFile(path, { encoding: 'utf-8' })) as string,
      writeFile: async (path: string, content: string) => {
        await this.fs.writeFile(path, content);
      },
      readDir: async (path: string) => {
        const entries = await this.fs.readDir(path);
        return entries.map((e) => ({ name: e.name, type: e.type }));
      },
      exists: async (path: string) => this.fs.exists(path),
      stat: async (path: string) => {
        const s = await this.fs.stat(path);
        return { type: s.type, size: s.size };
      },
      mkdir: async (path: string) => {
        await this.fs.mkdir(path, { recursive: true });
      },
      rm: async (path: string) => {
        await this.fs.rm(path);
      },
      screenshot: async () => '',
      setState: (data: unknown) => {
        try {
          localStorage.setItem(`slicc-sprinkle-state:${sprinkleName}`, JSON.stringify(data));
        } catch {
          /* full */
        }
      },
      getState: (): unknown => {
        try {
          const raw = localStorage.getItem(`slicc-sprinkle-state:${sprinkleName}`);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      },
      open: (path: string) => {
        const url = /^https?:|^chrome-extension:/.test(path) ? path : toPreviewUrl(path);
        window.open(url, '_blank');
      },
      close: () => this.closeHandler(sprinkleName),
    };
  }

  /** Push data to a sprinkle's update listeners. */
  pushUpdate(sprinkleName: string, data: unknown): void {
    const key = `${sprinkleName}:update`;
    const set = this.listeners.get(key);
    if (set) {
      for (const cb of set) {
        try {
          cb(data);
        } catch {
          /* ignore listener errors */
        }
      }
    }
  }

  /** Clean up listeners for a sprinkle. */
  removeSprinkle(sprinkleName: string): void {
    for (const key of this.listeners.keys()) {
      if (key.startsWith(`${sprinkleName}:`)) {
        this.listeners.delete(key);
      }
    }
  }
}
