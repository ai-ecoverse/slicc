/**
 * Kernel → page computer list + live-frame pump.
 *
 * Listens on the shared kernel transport for `computer-watch` /
 * `computer-unwatch` and pushes `computers` / `computer-frame`. Frames
 * cross only while at least one page subscriber exists. Polls are
 * serialized, timed out, and dropped if they complete after unwatch.
 */

import type { ComputerDescriptor, ComputerFrame } from '@slicc/shared-ts';
import type {
  ComputerInputMsg,
  ComputerUnwatchMsg,
  ComputerWatchMsg,
  ExtensionMessage,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
} from '../kernel/messages.js';
import type { ProcessManager } from '../kernel/process-manager.js';
import type { KernelTransport } from '../kernel/transport.js';
import type { ComputerBackend } from './backend.js';
import { installComputerRegistry } from './registry.js';

export const COMPUTER_POLL_TIMEOUT_MS = 8_000;

export interface ComputersHostOptions {
  transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;
  processManager: ProcessManager | null;
  pollTimeoutMs?: number;
}

export interface ComputersHostHandle {
  watch: (id: string, fps: number, maxWidth: number) => void;
  unwatch: (id: string) => void;
  stop: () => void;
}

interface Watcher {
  id: string;
  fps: number;
  maxWidth: number;
  generation: number;
  unsub: (() => void) | null;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
}

let activeHost: ComputersHostHandle | null = null;

export function getComputersHost(): ComputersHostHandle | null {
  return activeHost;
}

export function startComputersHost(options: ComputersHostOptions): ComputersHostHandle {
  const registry = installComputerRegistry(options.processManager);
  const watchers = new Map<string, Watcher>();
  const pollTimeoutMs = options.pollTimeoutMs ?? COMPUTER_POLL_TIMEOUT_MS;
  let lastList: ComputerDescriptor[] = registry.list();

  const send = (msg: OffscreenToPanelMessage, transfer?: Transferable[]): void => {
    options.transport.send(msg, transfer);
  };

  const pushList = (computers: ComputerDescriptor[]): void => {
    lastList = computers;
    send({ type: 'computers', computers });
  };

  const offChange = registry.onChange(pushList);

  const pushFrame = (id: string, frame: ComputerFrame, generation: number): void => {
    const watcher = watchers.get(id);
    if (!watcher || watcher.generation !== generation) return;
    const copy = frame.bytes.slice();
    send(
      {
        type: 'computer-frame',
        id,
        seq: frame.seq,
        mime: frame.mime,
        width: frame.width,
        height: frame.height,
        bytes: copy,
      },
      [copy.buffer]
    );
  };

  const stopWatch = (id: string): void => {
    const w = watchers.get(id);
    if (!w) return;
    w.generation += 1;
    watchers.delete(id);
    w.unsub?.();
    if (w.timer) clearInterval(w.timer);
  };

  const startWatch = (msg: ComputerWatchMsg): void => {
    stopWatch(msg.id);
    const backend = registry.get(msg.id);
    if (!backend) return;
    const fps = Math.max(1, Math.min(10, Math.round(msg.fps) || 2));
    const maxWidth = msg.maxWidth > 0 ? msg.maxWidth : 768;
    const watcher: Watcher = {
      id: msg.id,
      fps,
      maxWidth,
      generation: 1,
      unsub: null,
      timer: null,
      inFlight: false,
    };
    watchers.set(msg.id, watcher);
    if (backend.subscribe) {
      watcher.unsub = backend.subscribe(fps, (frame) =>
        pushFrame(msg.id, frame, watcher.generation)
      );
      return;
    }
    const interval = Math.round(1000 / fps);
    const poll = (): void => {
      void pollOnce(watcher, backend, pollTimeoutMs, (frame) =>
        pushFrame(msg.id, frame, watcher.generation)
      );
    };
    watcher.timer = setInterval(poll, interval);
    poll();
  };

  const unsubscribe = options.transport.onMessage((envelope) => {
    if (!envelope || typeof envelope !== 'object') return;
    if (!('source' in envelope) || envelope.source !== 'panel') return;
    const payload = envelope.payload as PanelToOffscreenMessage;
    if (payload.type === 'computer-watch') startWatch(payload as ComputerWatchMsg);
    else if (payload.type === 'computer-unwatch') stopWatch((payload as ComputerUnwatchMsg).id);
    else if (payload.type === 'computer-input') {
      const input = payload as ComputerInputMsg;
      void registry.get(input.id)?.input(input.events);
    }
  });

  send({ type: 'computers', computers: lastList });

  const handle: ComputersHostHandle = {
    watch: (id, fps, maxWidth) => startWatch({ type: 'computer-watch', id, fps, maxWidth }),
    unwatch: stopWatch,
    stop: () => {
      unsubscribe();
      offChange();
      for (const id of [...watchers.keys()]) stopWatch(id);
      if (activeHost === handle) activeHost = null;
    },
  };
  activeHost = handle;
  return handle;
}

async function pollOnce(
  watcher: Watcher,
  backend: ComputerBackend,
  timeoutMs: number,
  onFrame: (frame: ComputerFrame) => void
): Promise<void> {
  if (watcher.inFlight) return;
  watcher.inFlight = true;
  const generation = watcher.generation;
  try {
    const frame = await raceTimeout(
      backend.screenshot({ format: 'jpeg', maxWidth: watcher.maxWidth }),
      timeoutMs
    );
    if (watcher.generation !== generation) return;
    onFrame(frame);
  } catch {
    /* skip a missed or timed-out poll */
  } finally {
    if (watcher.generation === generation) watcher.inFlight = false;
  }
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('computer poll timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
