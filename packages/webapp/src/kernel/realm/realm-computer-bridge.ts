/**
 * `sliccy:computer` — a jsh-hosted computer backend. `register()`
 * subscribes to host `computer-call` events (keep-alive via `onEvent`)
 * and answers screenshot/input over the `computer` RPC channel.
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
}

export interface RealmComputerApi {
  register(handlers: RealmComputerHandlers): () => void;
}

interface ComputerCallPayload {
  requestId: string;
  id: string;
  op: 'screenshot' | 'text' | 'input' | 'exec';
  args: unknown[];
}

export function createComputerBridge(rpc: RealmRpcClient): RealmComputerApi {
  return {
    register(handlers: RealmComputerHandlers): () => void {
      const off = rpc.onEvent('computer-call', (raw) => {
        const payload = raw as ComputerCallPayload;
        if (payload.id !== handlers.id) return;
        void answerCall(rpc, handlers, payload);
      });
      const descriptor = toDescriptor(handlers);
      void rpc.call('computer', 'register', [descriptor]).catch(() => {
        /* realm already gone */
      });
      return () => {
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

async function answerCall(
  rpc: RealmRpcClient,
  handlers: RealmComputerHandlers,
  payload: ComputerCallPayload
): Promise<void> {
  let result: unknown;
  try {
    result = await invoke(handlers, payload);
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
  handlers: RealmComputerHandlers,
  payload: ComputerCallPayload
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
    default: {
      const _never: never = payload.op;
      throw new Error(`unknown computer op '${String(_never)}'`);
    }
  }
}
