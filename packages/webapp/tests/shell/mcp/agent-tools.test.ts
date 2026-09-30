import type { Tool } from '@earendil-works/pi-mcp';
import { describe, expect, it, vi } from 'vitest';
import { toAgentTools } from '../../../src/shell/mcp/agent-tools.js';
import type {
  McpCallToolResult,
  McpConnection,
} from '../../../src/shell/mcp/connection-manager.js';

function makeConnection(callResult?: McpCallToolResult): McpConnection {
  return {
    serverName: 'test-server',
    serverUrl: 'https://mcp.example.com',
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => callResult ?? { content: [{ type: 'text', text: 'ok' }] }),
    close: vi.fn(async () => {}),
  };
}

function makeTool(overrides?: Partial<Tool>): Tool {
  return {
    name: 'get-weather',
    description: 'Get the weather forecast',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude' },
        lon: { type: 'number', description: 'Longitude' },
      },
      required: ['lat', 'lon'],
    },
    ...overrides,
  };
}

describe('toAgentTools', () => {
  it('creates no tools when exposure is codemode (default)', () => {
    const connection = makeConnection();
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
    });
    expect(tools).toHaveLength(0);
  });

  it('creates tools when exposure is direct', () => {
    const connection = makeConnection();
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
      exposure: 'direct',
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('mcp__weather__get-weather');
    expect(tools[0].label).toBe('mcp:weather/get-weather');
  });

  it('respects per-tool exposure overrides', () => {
    const connection = makeConnection();
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool(), makeTool({ name: 'hidden-tool' })],
      connection,
      exposure: 'codemode',
      toolExposure: { 'get-weather': 'direct' },
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('mcp__weather__get-weather');
  });

  it('passes through inputSchema as parameters', () => {
    const connection = makeConnection();
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
      exposure: 'direct',
    });
    const params = tools[0].parameters as Record<string, unknown>;
    expect(params.type).toBe('object');
    expect(params.properties).toBeDefined();
  });

  it('passes through outputSchema', () => {
    const connection = makeConnection();
    const outputSchema = { type: 'object', properties: { temp: { type: 'number' } } };
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool({ outputSchema })],
      connection,
      exposure: 'direct',
    });
    expect(tools[0].outputSchema).toEqual(outputSchema);
  });

  it('execute calls the connection and returns content', async () => {
    const connection = makeConnection({
      content: [{ type: 'text', text: 'Sunny, 72F' }],
    });
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
      exposure: 'direct',
    });

    const result = await tools[0].execute('call-1', { lat: 51.5, lon: -0.12 });
    expect(result.content).toEqual([{ type: 'text', text: 'Sunny, 72F' }]);
    expect(result.isError).toBeUndefined();
    expect(connection.callTool).toHaveBeenCalledWith(
      'get-weather',
      { lat: 51.5, lon: -0.12 },
      { signal: undefined }
    );
  });

  it('forwards isError from the MCP result', async () => {
    const connection = makeConnection({
      content: [{ type: 'text', text: 'Not found' }],
      isError: true,
    });
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
      exposure: 'direct',
    });

    const result = await tools[0].execute('call-2', { lat: 0, lon: 0 });
    expect(result.isError).toBe(true);
  });

  it('returns error content on connection failure', async () => {
    const connection = makeConnection();
    (connection.callTool as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Connection lost')
    );
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
      exposure: 'direct',
    });

    const result = await tools[0].execute('call-3', { lat: 0, lon: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'MCP tool error: Connection lost',
    });
  });

  it('handles structuredContent in the result', async () => {
    const connection = makeConnection({
      content: [{ type: 'text', text: 'Sunny' }],
      structuredContent: { temperature: 72, unit: 'F' },
    });
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
      exposure: 'direct',
    });

    const result = await tools[0].execute('call-4', { lat: 0, lon: 0 });
    expect(result.structuredContent).toEqual({ temperature: 72, unit: 'F' });
  });

  it('truncates text content over 20KB', async () => {
    const largeText = 'x'.repeat(25_000);
    const connection = makeConnection({
      content: [{ type: 'text', text: largeText }],
    });
    const writeOverflow = vi.fn(async () => {});
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
      exposure: 'direct',
      writeOverflow,
    });

    const result = await tools[0].execute('call-5', { lat: 0, lon: 0 });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text.length).toBeLessThan(largeText.length);
    expect(text).toContain('truncated');
    expect(text).toContain('/tmp/mcp/');
    expect(writeOverflow).toHaveBeenCalledWith('call-5', largeText);
  });

  it('converts image content', async () => {
    const connection = makeConnection({
      content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' } as any],
    });
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
      exposure: 'direct',
    });

    const result = await tools[0].execute('call-6', {});
    expect(result.content[0]).toEqual({
      type: 'image',
      data: 'base64data',
      mimeType: 'image/png',
    });
  });

  it('converts resource content with text', async () => {
    const connection = makeConnection({
      content: [
        {
          type: 'resource',
          resource: { uri: 'file:///data.txt', text: 'hello', mimeType: 'text/plain' },
        } as any,
      ],
    });
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
      exposure: 'direct',
    });

    const result = await tools[0].execute('call-7', {});
    expect(result.content[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('produces empty-result fallback when content is empty', async () => {
    const connection = makeConnection({ content: [] });
    const tools = toAgentTools({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
      exposure: 'direct',
    });

    const result = await tools[0].execute('call-8', {});
    expect(result.content[0]).toEqual({ type: 'text', text: '(empty result)' });
  });
});
