import { describe, expect, it } from 'vitest';
import { handleJsonRpc, type RpcTool } from '../../../src/shell/mcp/serve-jsonrpc.js';

const tools: RpcTool[] = [
  {
    name: 'jira_get',
    description: 'Fetch',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function call(name: string, args: unknown) {
  return Promise.resolve({
    stdout: name === 'jira_get' ? 'ok' : '',
    stderr: args && typeof args === 'object' && 'fail' in args ? 'nope' : '',
    exitCode: args && typeof args === 'object' && 'fail' in args ? 2 : 0,
  });
}

describe('handleJsonRpc', () => {
  it('answers server/discover with a supported protocol list', async () => {
    const outcome = await handleJsonRpc(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
      tools,
      call
    );
    const body = JSON.parse(outcome.body) as { result: { supportedVersions: string[] } };
    expect(outcome.status).toBe(200);
    expect(body.result.supportedVersions).toEqual(['2026-07-28', '2025-06-18']);
  });

  it('answers a notification with an empty 202', async () => {
    const outcome = await handleJsonRpc(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      tools,
      call
    );
    expect(outcome).toMatchObject({ status: 202, body: '' });
  });

  it('rejects a batch', async () => {
    const outcome = await handleJsonRpc(
      JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
      tools,
      call
    );
    expect(JSON.parse(outcome.body).error.code).toBe(-32600);
  });

  it('reports an unknown tool as a JSON-RPC error', async () => {
    const outcome = await handleJsonRpc(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'missing', arguments: {} },
      }),
      tools,
      call
    );
    expect(outcome.status).toBe(200);
    expect(JSON.parse(outcome.body).error.message).toContain('Unknown tool');
  });

  it('marks a non-zero exit as an error and appends stderr', async () => {
    const outcome = await handleJsonRpc(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'jira_get', arguments: { fail: true } },
      }),
      tools,
      call
    );
    const result = JSON.parse(outcome.body).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('ok\nnope');
    expect(result.structuredContent).toEqual({ stdout: 'ok', stderr: 'nope', exitCode: 2 });
  });

  it('caps a huge stdout', async () => {
    const outcome = await handleJsonRpc(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'jira_get', arguments: {} },
      }),
      tools,
      () => Promise.resolve({ stdout: 'x'.repeat(100_050), stderr: '', exitCode: 0 })
    );
    const text = JSON.parse(outcome.body).result.content[0].text as string;
    expect(text.startsWith('x'.repeat(100_000))).toBe(true);
    expect(text).toContain('truncated');
  });
});
