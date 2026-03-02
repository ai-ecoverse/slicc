/**
 * Tool registry — registers tools and dispatches tool calls.
 *
 * Converts internal ToolDefinition format to the Anthropic API's Tool format
 * and dispatches tool execution when the LLM requests a tool call.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition, ToolResult } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** Register a tool. Throws if a tool with the same name already exists. */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Register multiple tools at once. */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Unregister a tool by name. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Get a tool by name, or undefined if not found. */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get all registered tool names. */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Convert all registered tools to the Anthropic API format. */
  toAnthropicTools(): Anthropic.Tool[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  /**
   * Execute a tool by name with the given input.
   * Returns a ToolResult, catching any errors.
   */
  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }

    try {
      return await tool.execute(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Tool error: ${message}`, isError: true };
    }
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}
