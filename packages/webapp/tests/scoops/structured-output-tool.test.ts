import { describe, expect, it } from 'vitest';
import { createStructuredOutputTool } from '../../src/scoops/structured-output-tool.js';

describe('createStructuredOutputTool', () => {
  it('exposes the schema as inputSchema and captures args on execute', async () => {
    const cap: { v: unknown } = { v: undefined };
    const tool = createStructuredOutputTool(
      { type: 'object', properties: { n: { type: 'number' } } },
      (v) => {
        cap.v = v;
      }
    );
    expect(tool.name).toBe('StructuredOutput');
    expect(tool.inputSchema).toEqual({ type: 'object', properties: { n: { type: 'number' } } });
    const r = await tool.execute({ n: 7 });
    expect(cap.v).toEqual({ n: 7 });
    expect(r.isError).toBeFalsy();
  });
});
