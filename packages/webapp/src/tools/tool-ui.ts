/**
 * Tool UI — allows tools to inject interactive UI elements into the chat.
 *
 * Tools can call `showToolUI()` to display HTML content in the chat that
 * the user can interact with. This is useful for:
 * - Approval dialogs (e.g., filesystem access)
 * - File pickers (requires user gesture)
 * - OAuth flows
 * - Any tool that needs user input mid-execution
 *
 * The UI is rendered in a sandboxed iframe (like sprinkles) and actions
 * are posted back either via callback (with user gesture context) or
 * as tool results.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('tool-ui');

export interface ToolUIRequest {
  /** Unique ID for this UI request (auto-generated if not provided) */
  id?: string;
  /** HTML content to render */
  html: string;
  /**
   * Optional callback for handling actions. Receives user gesture context,
   * so can call APIs like showDirectoryPicker().
   * Return value becomes the resolved result.
   * If not provided, action data is returned directly.
   */
  onAction?: (action: string, data?: unknown) => Promise<unknown> | unknown;
}

export interface ToolUIAction {
  action: string;
  data?: unknown;
}

/** Content type for tool UI requests in onUpdate */
export interface ToolUIContent {
  type: 'tool_ui';
  requestId: string;
  html: string;
}

/**
 * Reserved action name the chat panel posts back over the same
 * `tool-ui-action` channel once it has mounted the dip/card for a
 * `tool_ui` event. The bridge routes this to {@link ToolUIRegistry.markMounted}
 * instead of {@link ToolUIRegistry.handleAction} — it's purely an ack so
 * callers (e.g. the mount backend) can detect a panel that never rendered
 * the card and fail fast.
 */
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

/**
 * Registry for pending tool UI interactions.
 * Maps request IDs to their Promise resolvers.
 */
class ToolUIRegistry {
  private pending = new Map<string, PendingUI>();
  private idCounter = 0;
  /**
   * Request ids whose dip / card the chat panel reports having mounted —
   * see {@link markMounted}. Used by `waitForMount` so callers (e.g. the
   * mount backend) can fail fast when no panel ever renders the card.
   */
  private mounted = new Set<string>();
  private mountWaiters = new Map<string, PendingMountWait>();

  /** Generate a unique request ID */
  generateId(): string {
    return `tool-ui-${++this.idCounter}-${Date.now().toString(36)}`;
  }

  /** Register a pending UI request */
  register(
    id: string,
    request: ToolUIRequest,
    resolve: (result: unknown) => void,
    reject: (error: Error) => void
  ): void {
    // Re-registering the same id (e.g. agent retry) resets mount state so
    // a stale earlier `markMounted` can't satisfy the new request's wait.
    this.mounted.delete(id);
    this.pending.set(id, { request, resolve, reject });
    log.info('Tool UI registered', { id });
  }

  /** Handle an action from the UI (called by chat panel when user interacts) */
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
        // Call the callback with user gesture context
        result = await pending.request.onAction(action.action, action.data);
      } else {
        // No callback — return the action directly
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

  /** Cancel a pending tool UI (e.g., tool was aborted) */
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

  /** Cancel all pending UIs (e.g., agent stopped) */
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

  /** Check if a request is pending */
  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** Get all pending request IDs */
  getPendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * The chat panel calls this once it has mounted the dip/card for `id`.
   * Resolves any in-flight {@link waitForMount} promise. Idempotent.
   */
  markMounted(id: string): void {
    this.mounted.add(id);
    const waiter = this.mountWaiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timeoutHandle);
      this.mountWaiters.delete(id);
      waiter.resolve();
    }
  }

  /**
   * Wait up to `timeoutMs` for the chat panel to {@link markMounted} for
   * `id`. Resolves immediately if already mounted; rejects with a clear
   * "no panel mounted the card" error on timeout. Lets callers (e.g. the
   * mount backend) fail fast instead of hanging for minutes when no
   * panel is listening for the `tool_ui` event.
   */
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

  /** @internal Drop any in-flight mount waiter for `id`. */
  private clearMountWaiter(id: string, reason: string): void {
    const waiter = this.mountWaiters.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timeoutHandle);
    this.mountWaiters.delete(id);
    waiter.reject(new Error(reason));
  }
}

// Global singleton registry
export const toolUIRegistry = new ToolUIRegistry();

/** Type for the onUpdate callback from AgentTool - uses any to avoid import cycles */
type OnUpdateCallback = (partialResult: any) => void;

/**
 * Show interactive UI from a tool execution.
 *
 * Uses the tool's onUpdate callback to emit the UI request to the chat panel.
 * The returned Promise resolves when the user interacts with the UI.
 * If `onAction` callback is provided, it runs with user gesture context
 * (allowing APIs like showDirectoryPicker).
 *
 * @param request - The UI request configuration
 * @param onUpdate - The tool's onUpdate callback (from execute params)
 * @returns Promise that resolves with the user's action result
 *
 * @example
 * ```typescript
 * // Inside a tool's execute function:
 * const result = await showToolUI({
 *   html: `
 *     <div class="tool-ui">
 *       <p>Allow filesystem access at <code>/workspace</code>?</p>
 *       <div class="tool-ui__actions">
 *         <button class="tool-ui__btn tool-ui__btn--primary" data-action="approve">
 *           Select Directory
 *         </button>
 *         <button class="tool-ui__btn tool-ui__btn--secondary" data-action="deny">
 *           Deny
 *         </button>
 *       </div>
 *     </div>
 *   `,
 *   onAction: async (action) => {
 *     if (action === 'approve') {
 *       // Has user gesture — can call picker!
 *       return await showDirectoryPicker({ mode: 'readwrite' });
 *     }
 *     return { denied: true };
 *   }
 * }, onUpdate);
 * ```
 */
export async function showToolUI(
  request: ToolUIRequest,
  onUpdate?: OnUpdateCallback
): Promise<unknown> {
  const id = request.id ?? toolUIRegistry.generateId();

  // Create promise manually for broader ES target compatibility
  let resolve: (value: unknown) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  // Register in the global registry so handleAction can find it
  toolUIRegistry.register(id, request, resolve!, reject!);

  // Emit via onUpdate so the UI layer can render it
  if (onUpdate) {
    onUpdate({
      content: [
        {
          type: 'tool_ui',
          requestId: id,
          html: request.html,
        } as { type: string; requestId: string; html: string },
      ],
    });
  } else {
    log.warn('showToolUI called without onUpdate callback — UI may not render');
  }

  // When promise settles, emit tool_ui_done so the renderer can clean up
  return promise.finally(() => {
    if (onUpdate) {
      onUpdate({
        content: [
          {
            type: 'tool_ui_done',
            requestId: id,
          } as { type: string; requestId: string },
        ],
      });
    }
  });
}

/**
 * Execution context for tool UI - set by the tool adapter during execution.
 * This allows shell commands (like mount) to show UI even though they don't
 * have direct access to onUpdate.
 */
export interface ToolExecutionContext {
  onUpdate: OnUpdateCallback;
  toolName: string;
  toolCallId: string;
}

/**
 * Stack of execution contexts to handle nested/concurrent tool calls.
 * Each tool pushes its context on start and pops on finish.
 */
const executionContextStack: ToolExecutionContext[] = [];

/**
 * Push a tool execution context onto the stack.
 * Call this before executing a tool that might need to show UI.
 * Returns the context so it can be passed to popToolExecutionContext.
 */
export function pushToolExecutionContext(ctx: ToolExecutionContext): ToolExecutionContext {
  executionContextStack.push(ctx);
  return ctx;
}

/**
 * Pop a specific tool execution context from the stack.
 * Call this after tool execution completes.
 */
export function popToolExecutionContext(ctx: ToolExecutionContext): void {
  const idx = executionContextStack.lastIndexOf(ctx);
  if (idx !== -1) {
    executionContextStack.splice(idx, 1);
  }
}

/**
 * Get the current (top) tool execution context.
 * Returns null if not in a tool execution context.
 */
export function getToolExecutionContext(): ToolExecutionContext | null {
  return executionContextStack.length > 0
    ? executionContextStack[executionContextStack.length - 1]
    : null;
}

/**
 * Show tool UI using the current execution context.
 * For use by shell commands that don't have direct access to onUpdate.
 * Returns null if no execution context is available.
 */
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

/**
 * Default styles for tool UI elements.
 * Can be injected into the sandbox or used as a reference.
 */
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
