/**
 * Tool registry — registers tools and dispatches tool calls.
 *
 * Manages ToolDefinition objects and dispatches tool execution by name.
 */

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

  /** Get all registered tools as an array. */
  toArray(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Execute a tool by name with the given input.
   * Returns a ToolResult, catching any errors.
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }

    try {
      return await tool.execute(input, signal);
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
