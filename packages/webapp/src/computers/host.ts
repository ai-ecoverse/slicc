/**
 * Kernel → page computer list + live-frame pump.
 *
 * Listens on the shared kernel transport for `computer-watch` /
 * `computer-unwatch` and pushes `computers` / `computer-frame`. Frames
 * cross only while at least one page subscriber exists.
 */

import type { ComputerDescriptor, ComputerFrame } from '@slicc/shared-ts';
import type {
  ComputerUnwatchMsg,
  ComputerWatchMsg,
  ExtensionMessage,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
} from '../kernel/messages.js';
import type { ProcessManager } from '../kernel/process-manager.js';
import type { KernelTransport } from '../kernel/transport.js';
import { installComputerRegistry } from './registry.js';

export interface ComputersHostOptions {
  transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;
  processManager: ProcessManager | null;
}

export interface ComputersHostHandle {
  stop: () => void;
}

interface Watcher {
  id: string;
  fps: number;
  maxWidth: number;
  unsub: (() => void) | null;
  timer: ReturnType<typeof setInterval> | null;
}

export function startComputersHost(options: ComputersHostOptions): ComputersHostHandle {
  const registry = installComputerRegistry(options.processManager);
  const watchers = new Map<string, Watcher>();
  let lastList: ComputerDescriptor[] = registry.list();

  const send = (msg: OffscreenToPanelMessage, transfer?: Transferable[]): void => {
    options.transport.send(msg, transfer);
  };

  const pushList = (computers: ComputerDescriptor[]): void => {
    lastList = computers;
    send({ type: 'computers', computers });
  };

  const offChange = registry.onChange(pushList);

  const pushFrame = (id: string, frame: ComputerFrame): void => {
    if (watchers.size === 0) return;
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
    const watcher: Watcher = { id: msg.id, fps, maxWidth, unsub: null, timer: null };
    watchers.set(msg.id, watcher);
    if (backend.subscribe) {
      watcher.unsub = backend.subscribe(fps, (frame) => pushFrame(msg.id, frame));
      return;
    }
    const interval = Math.round(1000 / fps);
    watcher.timer = setInterval(() => {
      void backend
        .screenshot({ format: 'jpeg', maxWidth })
        .then((frame) => pushFrame(msg.id, frame))
        .catch(() => {
          /* skip a missed poll */
        });
    }, interval);
  };

  const unsubscribe = options.transport.onMessage((envelope) => {
    if (!envelope || typeof envelope !== 'object') return;
    if (!('source' in envelope) || envelope.source !== 'panel') return;
    const payload = envelope.payload as PanelToOffscreenMessage;
    if (payload.type === 'computer-watch') startWatch(payload as ComputerWatchMsg);
    else if (payload.type === 'computer-unwatch') stopWatch((payload as ComputerUnwatchMsg).id);
  });

  send({ type: 'computers', computers: lastList });

  return {
    stop: () => {
      unsubscribe();
      offChange();
      for (const id of [...watchers.keys()]) stopWatch(id);
    },
  };
}
