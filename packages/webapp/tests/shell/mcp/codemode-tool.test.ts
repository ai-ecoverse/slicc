import type { Tool } from '@earendil-works/pi-mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  McpCallToolResult,
  McpConnection,
} from '../../../src/shell/mcp/connection-manager.js';

// ── Mock pi-codemode ────────────────────────────────────────────────

const mockRegisterTool = vi.fn();
const mockUnregisterTool = vi.fn();
const mockExecute = vi.fn();
const mockClose = vi.fn();

class MockCodemodeSandbox {
  registerTool = mockRegisterTool;
  unregisterTool = mockUnregisterTool;
  execute = mockExecute;
  close = mockClose;
}

vi.mock('@earendil-works/pi-codemode', () => ({
  CodemodeSandbox: MockCodemodeSandbox,
  loadQuickJSWasm: vi.fn(() => Promise.resolve({})),
}));

// Import AFTER mock so the dynamic import resolves the mock.
const { createCodemodeAgentTool, closeSandbox } = await import(
  '../../../src/shell/mcp/codemode-tool.js'
);

// ── Helpers ─────────────────────────────────────────────────────────

function textContent(result: { content: { type: string; text?: string }[] }): string[] {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text);
}

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
      properties: { lat: { type: 'number' }, lon: { type: 'number' } },
      required: ['lat', 'lon'],
    },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('createCodemodeAgentTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await closeSandbox();
  });

  it('returns null when no tools match codemode exposure', () => {
    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
      exposure: 'direct',
    });
    expect(tool).toBeNull();
  });

  it('returns null for hidden exposure', () => {
    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
      exposure: 'hidden',
    });
    expect(tool).toBeNull();
  });

  it('creates a tool when default exposure is codemode', () => {
    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
    });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe('mcp__weather__codemode');
    expect(tool!.label).toBe('mcp:weather/codemode');
  });

  it('creates a tool for codemode-deferred exposure', () => {
    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
      exposure: 'codemode-deferred',
    });
    expect(tool).not.toBeNull();
  });

  it('respects per-tool exposure overrides', () => {
    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool(), makeTool({ name: 'alerts' })],
      connection: makeConnection(),
      exposure: 'direct',
      toolExposure: { alerts: 'codemode' },
    });
    expect(tool).not.toBeNull();
    expect(tool!.description).toContain('alerts');
    expect(tool!.description).not.toContain('get-weather');
  });

  it('includes tool descriptions in the codemode description', () => {
    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool(), makeTool({ name: 'alerts', description: 'Weather alerts' })],
      connection: makeConnection(),
    });
    expect(tool!.description).toContain('`get-weather`');
    expect(tool!.description).toContain('`alerts`');
    expect(tool!.description).toContain('Weather alerts');
  });

  it('has a code parameter in its schema', () => {
    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
    });
    const params = tool!.parameters as { properties: { code: unknown }; required: string[] };
    expect(params.properties.code).toBeDefined();
    expect(params.required).toContain('code');
  });
});

describe('codemode execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await closeSandbox();
  });

  it('registers tools, executes code, then unregisters', async () => {
    mockExecute.mockResolvedValueOnce({
      ok: true,
      value: 42,
      output: [],
      calls: [],
    });

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
    })!;

    await tool.execute('call-1', { code: 'return 42' });

    expect(mockRegisterTool).toHaveBeenCalledTimes(1);
    expect(mockRegisterTool.mock.calls[0][0].name).toBe('get-weather');
    expect(mockExecute).toHaveBeenCalledWith('return 42', { signal: undefined });
    expect(mockUnregisterTool).toHaveBeenCalledWith('get-weather');
  });

  it('unregisters tools even when execution throws', async () => {
    mockExecute.mockRejectedValueOnce(new Error('timeout'));

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
    })!;

    const result = await tool.execute('call-2', { code: 'while(true){}' });
    expect(result.isError).toBe(true);
    expect(mockUnregisterTool).toHaveBeenCalledWith('get-weather');
  });

  it('formats a successful result with a return value', async () => {
    mockExecute.mockResolvedValueOnce({
      ok: true,
      value: { temp: 72 },
      output: [{ type: 'text', text: 'Fetched data.' }],
      calls: [{ name: 'get-weather', status: 'ok', durationMs: 123.4 }],
    });

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
    })!;

    const result = await tool.execute('call-3', { code: 'return tools.getWeather()' });
    expect(result.isError).toBeUndefined();

    const texts = textContent(result);
    expect(texts[0]).toContain('Script completed');
    expect(texts[0]).toContain('get-weather (ok, 123ms)');
    expect(texts[1]).toBe('Fetched data.');
    expect(texts[2]).toBe('{"temp":72}');
  });

  it('formats a string return value without JSON wrapping', async () => {
    mockExecute.mockResolvedValueOnce({
      ok: true,
      value: 'hello world',
      output: [],
      calls: [],
    });

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
    })!;

    const result = await tool.execute('call-4', { code: 'return "hello world"' });
    expect(textContent(result)).toContain('hello world');
  });

  it('formats a script error result', async () => {
    mockExecute.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'script', name: 'TypeError', message: 'x is not a function', stack: null },
      output: [],
      calls: [],
    });

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
    })!;

    const result = await tool.execute('call-5', { code: 'x()' });
    expect(result.isError).toBe(true);

    const texts = textContent(result);
    const errorText = texts.find((t) => t.includes('Script error'));
    expect(errorText).toContain('TypeError: x is not a function');
  });

  it('formats a timeout error result', async () => {
    mockExecute.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'timeout', message: 'Execution timed out after 300000ms' },
      output: [],
      calls: [],
    });

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
    })!;

    const result = await tool.execute('call-6', { code: 'while(true){}' });
    expect(result.isError).toBe(true);
    expect(textContent(result).find((t) => t.includes('timeout'))).toBeDefined();
  });

  it('produces an empty-result fallback', async () => {
    mockExecute.mockResolvedValueOnce({
      ok: true,
      value: undefined,
      output: [],
      calls: [],
    });

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
    })!;

    const result = await tool.execute('call-7', { code: '' });
    expect(textContent(result)).toContain('(empty result)');
  });

  it('handles image output items', async () => {
    mockExecute.mockResolvedValueOnce({
      ok: true,
      value: undefined,
      output: [{ type: 'image', data: 'abc123', mimeType: 'image/png' }],
      calls: [],
    });

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
    })!;

    const result = await tool.execute('call-8', { code: '' });
    const images = result.content.filter((b: { type: string }) => b.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({ type: 'image', data: 'abc123', mimeType: 'image/png' });
  });

  it('returns error result when execution rejects', async () => {
    mockExecute.mockRejectedValueOnce(new Error('WASM load failed'));

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection: makeConnection(),
    })!;

    const result = await tool.execute('call-9', { code: 'return 1' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('WASM load failed');
  });
});

describe('codemode tool-call bridging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await closeSandbox();
  });

  it('bridges tool calls to the MCP connection', async () => {
    const connection = makeConnection({
      content: [{ type: 'text', text: 'Sunny, 72F' }],
    });

    mockExecute.mockImplementationOnce(async () => {
      const registered = mockRegisterTool.mock.calls[0][0];
      const toolResult = await registered.execute(
        { lat: 51.5, lon: -0.12 },
        { signal: AbortSignal.timeout(5000) }
      );
      return { ok: true, value: toolResult, output: [], calls: [] };
    });

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
    })!;

    await tool.execute('call-10', { code: 'return await tools.getWeather({lat:51.5,lon:-0.12})' });

    expect(connection.callTool).toHaveBeenCalledWith(
      'get-weather',
      { lat: 51.5, lon: -0.12 },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('returns structuredContent when available', async () => {
    const connection = makeConnection({
      content: [{ type: 'text', text: 'data' }],
      structuredContent: { temp: 72 },
    });

    mockExecute.mockImplementationOnce(async () => {
      const registered = mockRegisterTool.mock.calls[0][0];
      const toolResult = await registered.execute({}, { signal: AbortSignal.timeout(5000) });
      return { ok: true, value: toolResult, output: [], calls: [] };
    });

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
    })!;

    const result = await tool.execute('call-11', { code: '' });
    expect(textContent(result)).toContain('{"temp":72}');
  });

  it('throws on MCP tool error', async () => {
    const connection = makeConnection({
      content: [{ type: 'text', text: 'Not found' }],
      isError: true,
    });

    mockExecute.mockImplementationOnce(async () => {
      const registered = mockRegisterTool.mock.calls[0][0];
      try {
        await registered.execute({}, { signal: AbortSignal.timeout(5000) });
        return { ok: true, value: 'should not reach', output: [], calls: [] };
      } catch (err: unknown) {
        return {
          ok: false,
          error: { kind: 'script', message: (err as Error).message, name: 'Error', stack: null },
          output: [],
          calls: [],
        };
      }
    });

    const tool = createCodemodeAgentTool({
      serverName: 'weather',
      tools: [makeTool()],
      connection,
    })!;

    const result = await tool.execute('call-12', { code: '' });
    expect(result.isError).toBe(true);
    expect(textContent(result).find((t) => t.includes('Not found'))).toBeDefined();
  });
});
