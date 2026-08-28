import { describe, expect, it } from 'vitest';
import type {
  AgentTool,
  AgentToolParams,
  ToolCall,
  ToolCallArguments,
} from '../../src/core/types.js';

describe('core ToolCallArguments / AgentToolParams', () => {
  it('accepts a model-emitted argument bag on ToolCall', () => {
    const arguments_: ToolCallArguments = { path: '/workspace/a.ts', limit: 20 };
    const call: ToolCall = {
      type: 'toolCall',
      id: 'tc_1',
      name: 'read',
      arguments: arguments_,
    };
    expect(call.arguments.path).toBe('/workspace/a.ts');
    expect(Object.keys(call.arguments)).toEqual(['path', 'limit']);
  });

  it('passes the same bag shape into AgentTool.execute', async () => {
    const seen: AgentToolParams[] = [];
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
    const params: AgentToolParams = { message: 'hi' };
    const result = await tool.execute('tc_2', params);
    expect(seen).toEqual([{ message: 'hi' }]);
    expect(result.details).toBe('ok');
  });
});
