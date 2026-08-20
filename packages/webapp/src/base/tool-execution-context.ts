/**
 * Tool execution context — the ambient "which tool call am I inside" stack.
 *
 * The tool adapter pushes a context before running a tool and pops it after,
 * so a shell command reached indirectly (like `mount`) can discover the
 * `onUpdate` channel it was never handed. A stack rather than a single slot,
 * because tool calls nest and run concurrently.
 *
 * This lives in `base/` rather than beside `showToolUI` because the *reader*
 * is needed a rung below the shell — `fs/mount-commands.ts` branches on
 * whether it is running inside a cone tool call — and an `fs → shell` import
 * would invert the layer stack. `shell/tool-ui.ts` re-exports the whole
 * surface, so existing callers are unaffected.
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core';

export type OnUpdateCallback = (partialResult: AgentToolResult<unknown>) => void;

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
