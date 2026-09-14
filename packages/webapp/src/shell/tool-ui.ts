import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { createLogger } from '../base/logger.js';
import {
  type OnUpdateCallback as BaseOnUpdateCallback,
  getToolExecutionContext,
} from '../base/tool-execution-context.js';

export type { ToolExecutionContext } from '../base/tool-execution-context.js';
export {
  getToolExecutionContext,
  popToolExecutionContext,
  pushToolExecutionContext,
} from '../base/tool-execution-context.js';

const log = createLogger('tool-ui');

export interface ToolUIRequest {
  id?: string;

  html: string;

  onAction?: (action: string, data?: unknown) => Promise<unknown> | unknown;
}

export interface ToolUIAction {
  action: string;
  data?: unknown;
}

export interface ToolUIContent {
  type: 'tool_ui';
  requestId: string;
  html: string;
}

export const TOOL_UI_MOUNTED_ACTION = '__mounted';

interface PendingUI {
  request: ToolUIRequest;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingMountWait {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

class ToolUIRegistry {
  private pending = new Map<string, PendingUI>();
  private idCounter = 0;

  private mounted = new Set<string>();
  private mountWaiters = new Map<string, PendingMountWait>();

  generateId(): string {
    return `tool-ui-${++this.idCounter}-${Date.now().toString(36)}`;
  }

  register(
    id: string,
    request: ToolUIRequest,
    resolve: (result: unknown) => void,
    reject: (error: Error) => void
  ): void {
    this.mounted.delete(id);
    this.pending.set(id, { request, resolve, reject });
    log.info('Tool UI registered', { id });
  }

  async handleAction(id: string, action: ToolUIAction): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) {
      log.warn('Action for unknown tool UI', { id, action: action.action });
      return;
    }

    log.info('Tool UI action', { id, action: action.action });

    try {
      let result: unknown;

      if (pending.request.onAction) {
        result = await pending.request.onAction(action.action, action.data);
      } else {
        result = action;
      }

      pending.resolve(result);
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.pending.delete(id);
      this.clearMountWaiter(id, 'tool ui completed');
    }
  }

  cancel(id: string, reason = 'cancelled'): void {
    const pending = this.pending.get(id);
    if (pending) {
      pending.reject(new Error(reason));
      this.pending.delete(id);
      log.info('Tool UI cancelled', { id, reason });
    }
    this.clearMountWaiter(id, reason);
    this.mounted.delete(id);
  }

  cancelAll(reason = 'cancelled'): void {
    const count = this.pending.size;
    for (const [_id, pending] of this.pending) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    for (const id of [...this.mountWaiters.keys()]) {
      this.clearMountWaiter(id, reason);
    }
    this.mounted.clear();
    if (count > 0) {
      log.info('All tool UIs cancelled', { reason, count });
    }
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  getPendingIds(): string[] {
    return [...this.pending.keys()];
  }

  markMounted(id: string): void {
    this.mounted.add(id);
    const waiter = this.mountWaiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timeoutHandle);
      this.mountWaiters.delete(id);
      waiter.resolve();
    }
  }

  waitForMount(id: string, timeoutMs: number): Promise<void> {
    if (this.mounted.has(id)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.mountWaiters.delete(id);
        reject(
          new Error(
            `tool UI ${id} was not mounted by any panel within ${timeoutMs}ms — check the chat panel`
          )
        );
      }, timeoutMs);
      this.mountWaiters.set(id, { resolve, reject, timeoutHandle });
    });
  }

  private clearMountWaiter(id: string, reason: string): void {
    const waiter = this.mountWaiters.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timeoutHandle);
    this.mountWaiters.delete(id);
    waiter.reject(new Error(reason));
  }
}

export const toolUIRegistry = new ToolUIRegistry();

type OnUpdateCallback = BaseOnUpdateCallback;

export async function showToolUI(
  request: ToolUIRequest,
  onUpdate?: OnUpdateCallback
): Promise<unknown> {
  const id = request.id ?? toolUIRegistry.generateId();

  let resolve: (value: unknown) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  toolUIRegistry.register(id, request, resolve!, reject!);

  if (onUpdate) {
    onUpdate({
      content: [
        {
          type: 'tool_ui',
          requestId: id,
          html: request.html,
        },
      ],
    } as unknown as AgentToolResult<unknown>);
  } else {
    log.warn('showToolUI called without onUpdate callback — UI may not render');
  }

  return promise.finally(() => {
    if (onUpdate) {
      onUpdate({
        content: [
          {
            type: 'tool_ui_done',
            requestId: id,
          },
        ],
      } as unknown as AgentToolResult<unknown>);
    }
  });
}

export async function showToolUIFromContext(
  request: Omit<ToolUIRequest, 'id'>
): Promise<unknown | null> {
  const ctx = getToolExecutionContext();
  if (!ctx) {
    log.warn('showToolUIFromContext called without execution context');
    return null;
  }
  return showToolUI(request, ctx.onUpdate);
}

export const TOOL_UI_STYLES = `
  .tool-ui {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    padding: 12px;
    background: var(--bg-secondary, #1a1a1a);
    border-radius: 8px;
    color: var(--text-primary, #e0e0e0);
  }

  .tool-ui p {
    margin: 0 0 12px 0;
  }

  .tool-ui code {
    background: var(--bg-tertiary, #2a2a2a);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 0.9em;
  }

  .tool-ui__actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  .tool-ui__btn {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .tool-ui__btn:hover {
    opacity: 0.9;
  }

  .tool-ui__btn--primary {
    background: var(--accent, #3b82f6);
    color: white;
  }

  .tool-ui__btn--secondary {
    background: var(--bg-tertiary, #2a2a2a);
    color: var(--text-primary, #e0e0e0);
  }

  .tool-ui__btn--danger {
    background: #dc2626;
    color: white;
  }
`;
