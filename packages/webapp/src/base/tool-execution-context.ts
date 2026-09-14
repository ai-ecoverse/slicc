import type { AgentToolResult } from '@earendil-works/pi-agent-core';

export type OnUpdateCallback = (partialResult: AgentToolResult<unknown>) => void;

export interface ToolExecutionContext {
  onUpdate: OnUpdateCallback;
  toolName: string;
  toolCallId: string;
}

const executionContextStack: ToolExecutionContext[] = [];

export function pushToolExecutionContext(ctx: ToolExecutionContext): ToolExecutionContext {
  executionContextStack.push(ctx);
  return ctx;
}

export function popToolExecutionContext(ctx: ToolExecutionContext): void {
  const idx = executionContextStack.lastIndexOf(ctx);
  if (idx !== -1) {
    executionContextStack.splice(idx, 1);
  }
}

export function getToolExecutionContext(): ToolExecutionContext | null {
  return executionContextStack.length > 0
    ? executionContextStack[executionContextStack.length - 1]
    : null;
}
