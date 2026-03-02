import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from './tool-registry.js';
import type { ToolDefinition } from './types.js';

function makeTool(name: string, result = 'ok'): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    async execute() {
      return { content: result };
    },
  };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('registers and retrieves a tool', () => {
    const tool = makeTool('test');
    registry.register(tool);
    expect(registry.get('test')).toBe(tool);
    expect(registry.has('test')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('throws on duplicate registration', () => {
    registry.register(makeTool('dup'));
    expect(() => registry.register(makeTool('dup'))).toThrow('already registered');
  });

  it('registerAll registers multiple tools', () => {
    registry.registerAll([makeTool('a'), makeTool('b'), makeTool('c')]);
    expect(registry.size).toBe(3);
    expect(registry.names()).toEqual(['a', 'b', 'c']);
  });

  it('unregisters a tool', () => {
    registry.register(makeTool('x'));
    expect(registry.unregister('x')).toBe(true);
    expect(registry.has('x')).toBe(false);
    expect(registry.unregister('x')).toBe(false);
  });

  it('converts to Anthropic tool format', () => {
    registry.register(makeTool('my_tool'));
    const tools = registry.toAnthropicTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      name: 'my_tool',
      description: 'Test tool: my_tool',
      input_schema: { type: 'object', properties: { x: { type: 'string' } } },
    });
  });

  it('executes a tool successfully', async () => {
    registry.register(makeTool('echo', 'hello'));
    const result = await registry.execute('echo', {});
    expect(result).toEqual({ content: 'hello' });
  });

  it('returns error for unknown tool', async () => {
    const result = await registry.execute('nonexistent', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown tool');
  });

  it('catches tool execution errors', async () => {
    const tool: ToolDefinition = {
      name: 'broken',
      description: 'Broken tool',
      inputSchema: { type: 'object' },
      async execute() {
        throw new Error('intentional failure');
      },
    };
    registry.register(tool);
    const result = await registry.execute('broken', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('intentional failure');
  });
});
