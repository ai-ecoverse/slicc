/**
 * `sliccy:computer` — a jsh-hosted computer backend. `register()`
 * subscribes to host `computer-call` events (keep-alive via `onEvent`)
 * and answers screenshot/input/subscribe over the `computer` RPC channel.
 *
 * `handlers.subscribe(fps, onFrame)` is the push path. Frames go back
 * with `computer.frame`; `unsubscribe` and unregister tear the stream
 * down. Screenshot on the host returns the last cached frame while the
 * stream is live.
 */

import type {
  ComputerCapabilities,
  ComputerDescriptor,
  ComputerExecResult,
  ComputerFrame,
  ComputerInputEvent,
  ComputerScreenshotOpts,
  ComputerSize,
  ComputerSoftKey,
} from '@slicc/shared-ts';
import type { RealmRpcClient } from './realm-rpc.js';

export interface RealmComputerHandlers {
  id: string;
  title?: string;
  size?: ComputerSize | null;
  capabilities: ComputerCapabilities;
  softKeys?: ComputerSoftKey[];
  screenshot: (opts: ComputerScreenshotOpts) => Promise<ComputerFrame>;
  text?: () => Promise<string | null>;
  input: (events: ComputerInputEvent[]) => Promise<void>;
  exec?: (command: string) => Promise<ComputerExecResult>;
  subscribe?(fps: number, onFrame: (frame: ComputerFrame) => void): () => void;
}

export interface RealmComputerApi {
  register(handlers: RealmComputerHandlers): () => void;
}

interface ComputerCallPayload {
  requestId: string;
  id: string;
  op: 'screenshot' | 'text' | 'input' | 'exec' | 'subscribe' | 'unsubscribe';
  args: unknown[];
}

export function createComputerBridge(rpc: RealmRpcClient): RealmComputerApi {
  return {
    register(handlers: RealmComputerHandlers): () => void {
      let stopStream: (() => void) | null = null;
      const off = rpc.onEvent('computer-call', (raw) => {
        const payload = raw as ComputerCallPayload;
        if (payload.id !== handlers.id) return;
        void answerCall(rpc, handlers, payload, {
          getStop: () => stopStream,
          setStop: (fn) => {
            stopStream = fn;
          },
        });
      });
      const descriptor = toDescriptor(handlers);
      void rpc.call('computer', 'register', [descriptor]).catch(() => {
        /* realm already gone */
      });
      return () => {
        stopStream?.();
        stopStream = null;
        off();
        void rpc.call('computer', 'unregister', [handlers.id]).catch(() => {
          /* realm already gone */
        });
      };
    },
  };
}

function toDescriptor(handlers: RealmComputerHandlers): ComputerDescriptor {
  return {
    id: handlers.id,
    kind: 'jsh',
    title: handlers.title ?? handlers.id,
    size: handlers.size ?? null,
    state: 'live',
    capabilities: handlers.capabilities,
    pid: null,
    ...(handlers.softKeys ? { softKeys: handlers.softKeys } : {}),
  };
}

interface StreamSlot {
  getStop: () => (() => void) | null;
  setStop: (fn: (() => void) | null) => void;
}

async function answerCall(
  rpc: RealmRpcClient,
  handlers: RealmComputerHandlers,
  payload: ComputerCallPayload,
  stream: StreamSlot
): Promise<void> {
  let result: unknown;
  try {
    result = await invoke(rpc, handlers, payload, stream);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  try {
    await rpc.call('computer', 'reply', [payload.requestId, result]);
  } catch {
    /* realm already gone */
  }
}

async function invoke(
  rpc: RealmRpcClient,
  handlers: RealmComputerHandlers,
  payload: ComputerCallPayload,
  stream: StreamSlot
): Promise<unknown> {
  switch (payload.op) {
    case 'screenshot':
      return handlers.screenshot((payload.args[0] as ComputerScreenshotOpts) ?? { format: 'jpeg' });
    case 'text':
      return handlers.text ? handlers.text() : null;
    case 'input':
      await handlers.input((payload.args[0] as ComputerInputEvent[]) ?? []);
      return { ok: true };
    case 'exec':
      if (!handlers.exec) throw new Error('exec is not supported');
      return handlers.exec(String(payload.args[0] ?? ''));
    case 'subscribe':
      return startStream(rpc, handlers, Number(payload.args[0]) || 2, stream);
    case 'unsubscribe':
      stream.getStop()?.();
      stream.setStop(null);
      return { ok: true };
    default: {
      const _never: never = payload.op;
      throw new Error(`unknown computer op '${String(_never)}'`);
    }
  }
}

function startStream(
  rpc: RealmRpcClient,
  handlers: RealmComputerHandlers,
  fps: number,
  stream: StreamSlot
): { ok: true } {
  stream.getStop()?.();
  if (!handlers.subscribe) throw new Error('subscribe is not supported');
  const stop = handlers.subscribe(fps, (frame) => {
    void rpc.call('computer', 'frame', [handlers.id, frame]).catch(() => {
      /* realm already gone */
    });
  });
  stream.setStop(() => {
    try {
      stop();
    } catch {
      /* handler already torn down */
    }
  });
  return { ok: true };
}
