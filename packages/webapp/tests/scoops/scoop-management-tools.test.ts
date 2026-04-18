/**
 * Tests for the `scoop_scoop` management tool — specifically the defaults it
 * injects into each newly created scoop's `ScoopConfig`. The orchestrator
 * layer uses pure-replace semantics, so any default the historical behavior
 * relied on MUST be injected here.
 */

import { describe, it, expect, vi } from 'vitest';
import { createScoopManagementTools } from '../../src/scoops/scoop-management-tools.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const cone: RegisteredScoop = {
  jid: 'cone_main_1',
  name: 'Main',
  folder: 'main',
  isCone: true,
  type: 'cone',
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: new Date().toISOString(),
};

function findScoopScoopTool() {
  const onScoopScoop = vi.fn(
    async (scoop: Omit<RegisteredScoop, 'jid'>): Promise<RegisteredScoop> => ({
      ...scoop,
      jid: `scoop_${scoop.folder}_${Date.now()}`,
    })
  );

  const tools = createScoopManagementTools({
    scoop: cone,
    onSendMessage: vi.fn(),
    getScoops: () => [cone],
    onScoopScoop,
  });

  const tool = tools.find((t) => t.name === 'scoop_scoop');
  if (!tool) throw new Error('scoop_scoop tool missing from cone toolset');
  return { tool, onScoopScoop };
}

describe('scoop_scoop tool — config defaults', () => {
  it('injects visiblePaths: ["/workspace/"] when no model is specified', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({ name: 'hero-block' });

    expect(onScoopScoop).toHaveBeenCalledTimes(1);
    const created = onScoopScoop.mock.calls[0][0];
    expect(created.config).toBeDefined();
    expect(created.config?.visiblePaths).toEqual(['/workspace/']);
  });

  it('keeps visiblePaths when a model is also specified', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({ name: 'hero-block', model: 'claude-sonnet-4-6' });

    const created = onScoopScoop.mock.calls[0][0];
    expect(created.config?.visiblePaths).toEqual(['/workspace/']);
    expect(created.config?.modelId).toBe('claude-sonnet-4-6');
  });

  it('passes an isCone=false scoop with a sanitized folder', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({ name: 'Hero Block #1' });

    const created = onScoopScoop.mock.calls[0][0];
    expect(created.isCone).toBe(false);
    expect(created.folder).toBe('hero-block-1-scoop');
  });
});
