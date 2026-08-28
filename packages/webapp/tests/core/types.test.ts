import { describe, expect, it } from 'vitest';
import type { AgentTool, ToolCall } from '../../src/core/types.js';

describe('core ToolCall.arguments / AgentTool.execute params', () => {
  it('accepts a model-emitted argument bag on ToolCall', () => {
    const call: ToolCall = {
      type: 'toolCall',
      id: 'tc_1',
      name: 'read',
      arguments: { path: '/workspace/a.ts', limit: 20 },
    };
    expect(call.arguments.path).toBe('/workspace/a.ts');
    expect(Object.keys(call.arguments)).toEqual(['path', 'limit']);
  });

  it('passes the same bag shape into AgentTool.execute', async () => {
    const seen: Record<string, unknown>[] = [];
    const tool: AgentTool<string> = {
      name: 'echo',
      description: 'echo params',
      label: 'Echo',
      parameters: { type: 'object', properties: {} },
      execute: async (_id, params) => {
        seen.push(params);
        return { content: [{ type: 'text', text: 'ok' }], details: 'ok' };
      },
    };
    const result = await tool.execute('tc_2', { message: 'hi' });
    expect(seen).toEqual([{ message: 'hi' }]);
    expect(result.details).toBe('ok');
  });
});
