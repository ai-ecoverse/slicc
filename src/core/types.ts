/**
 * Local types that extend or complement pi-mono types.
 *
 * All core agent types (AgentTool, AgentMessage, AgentEvent, etc.)
 * come from @mariozechner/pi-agent-core and @mariozechner/pi-ai.
 * This file defines only project-specific types.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';

// ─── Tool Schema ────────────────────────────────────────────────────────────

/** JSON Schema for tool input parameters (used by legacy ToolDefinition). */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

// ─── Agent Config (public API) ──────────────────────────────────────────────

/** Agent configuration for this project. */
export interface AgentConfig {
  /** API key for the LLM provider. */
  apiKey: string;
  /** Model ID string. Default: claude-opus-4-6 */
  model?: string;
  /** Maximum tokens per response. Default: 8192 */
  maxTokens?: number;
  /** System prompt. */
  systemPrompt?: string;
  /** Temperature. Default: 0 */
  temperature?: number;
}

// ─── Session Persistence ────────────────────────────────────────────────────

/** Serializable session data for IndexedDB persistence. */
export interface SessionData {
  id: string;
  messages: AgentMessage[];
  config: Omit<AgentConfig, 'apiKey'>;
  createdAt: number;
  updatedAt: number;
}

// ─── Legacy compat ──────────────────────────────────────────────────────────

/**
 * Legacy tool definition for backwards compatibility with existing tools.
 * Used by src/tools/ factories. The tool adapter converts these to AgentTool.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

/** Legacy tool result. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}
