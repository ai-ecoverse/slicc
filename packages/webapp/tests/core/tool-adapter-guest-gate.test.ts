import { describe, expect, it, vi } from 'vitest';
import { adaptTool, type ToolAdapterGateConfig } from '../../src/core/tool-adapter.js';
import type { ToolDefinition } from '../../src/tools/types.js';

function tool(execute = vi.fn(async () => ({ content: 'ran', isError: false }))): ToolDefinition {
  return {
    name: 'bash',
    description: 'run a command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    execute,
  } as unknown as ToolDefinition;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('');
}

describe('adaptTool guest gate', () => {
  it('runs the tool untouched when no gate is active', async () => {
    const exec = vi.fn(async () => ({ content: 'ran', isError: false }));
    const gate: ToolAdapterGateConfig = { currentGate: () => undefined };
    const adapted = adaptTool(tool(exec), undefined, undefined, gate);

    const out = await adapted.execute('c1', { command: 'ls' });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(textOf(out as never)).toContain('ran');
  });

  it('refuses the call and never executes when the gate denies', async () => {
    const exec = vi.fn(async () => ({ content: 'ran', isError: false }));
    const gate: ToolAdapterGateConfig = {
      currentGate: () => ({ approve: async () => false }),
    };
    const adapted = adaptTool(tool(exec), undefined, undefined, gate);

    const out = await adapted.execute('c1', { command: 'rm -rf /' });
    // Not "ran and then reported" — the tool must never have run at all.
    expect(exec).not.toHaveBeenCalled();
    expect((out as { details?: { isError?: boolean } }).details?.isError).toBe(true);
    expect(textOf(out as never)).toContain('not approved');
  });

  it('returns a result rather than throwing, so the turn survives a refusal', async () => {
    const gate: ToolAdapterGateConfig = {
      currentGate: () => ({ approve: async () => false }),
    };
    const adapted = adaptTool(tool(), undefined, undefined, gate);
    // A throw would abort the whole turn instead of the single action, and the
    // agent could not adapt.
    await expect(adapted.execute('c1', { command: 'ls' })).resolves.toBeDefined();
  });

  it('runs the tool when the gate approves', async () => {
    const exec = vi.fn(async () => ({ content: 'ran', isError: false }));
    const gate: ToolAdapterGateConfig = {
      currentGate: () => ({ approve: async () => true }),
    };
    const adapted = adaptTool(tool(exec), undefined, undefined, gate);
    await adapted.execute('c1', { command: 'ls' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the gate itself throws', async () => {
    const exec = vi.fn(async () => ({ content: 'ran', isError: false }));
    const gate: ToolAdapterGateConfig = {
      currentGate: () => ({
        approve: async () => {
          throw new Error('approval transport died');
        },
      }),
    };
    const adapted = adaptTool(tool(exec), undefined, undefined, gate);

    const out = await adapted.execute('c1', { command: 'ls' });
    // A gate that errored has not approved anything.
    expect(exec).not.toHaveBeenCalled();
    expect((out as { details?: { isError?: boolean } }).details?.isError).toBe(true);
  });

  it('consults the gate LIVE on each call, not once at build time', async () => {
    // Tools are built once per scoop; whether the current TURN was caused by a
    // guest changes underneath a long-lived tool set.
    const exec = vi.fn(async () => ({ content: 'ran', isError: false }));
    let gated = false;
    const gate: ToolAdapterGateConfig = {
      currentGate: () => (gated ? { approve: async () => false } : undefined),
    };
    const adapted = adaptTool(tool(exec), undefined, undefined, gate);

    await adapted.execute('c1', { command: 'ls' });
    expect(exec).toHaveBeenCalledTimes(1);

    gated = true;
    await adapted.execute('c2', { command: 'ls' });
    expect(exec).toHaveBeenCalledTimes(1);

    gated = false;
    await adapted.execute('c3', { command: 'ls' });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('passes the tool name and params to the gate', async () => {
    const approve = vi.fn(async () => true);
    const gate: ToolAdapterGateConfig = { currentGate: () => ({ approve }) };
    const adapted = adaptTool(tool(), undefined, undefined, gate);
    await adapted.execute('c1', { command: 'git push --force' });
    expect(approve).toHaveBeenCalledWith('bash', { command: 'git push --force' });
  });
});
