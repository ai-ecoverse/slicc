/**
 * Tests for the `scoop_scoop` management tool — specifically the defaults it
 * injects into each newly created scoop's `ScoopConfig`. The orchestrator
 * layer uses pure-replace semantics, so any default the historical behavior
 * relied on MUST be injected here.
 */

import { describe, it, expect, vi } from 'vitest';
import { createScoopManagementTools } from '../../src/scoops/scoop-management-tools.js';
import { CURRENT_SCOOP_CONFIG_VERSION, type RegisteredScoop } from '../../src/scoops/types.js';

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

  it('injects writablePaths scoped to the new scoop folder plus /shared/', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({ name: 'hero-block' });

    const created = onScoopScoop.mock.calls[0][0];
    expect(created.config?.writablePaths).toEqual([`/scoops/${created.folder}/`, '/shared/']);
  });

  it('passes an isCone=false scoop with a sanitized folder', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({ name: 'Hero Block #1' });

    const created = onScoopScoop.mock.calls[0][0];
    expect(created.isCone).toBe(false);
    expect(created.folder).toBe('hero-block-1-scoop');
  });

  it('stamps the current configSchemaVersion so the orchestrator skips compat migration', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({ name: 'hero-block' });

    const created = onScoopScoop.mock.calls[0][0];
    expect(created.configSchemaVersion).toBe(CURRENT_SCOOP_CONFIG_VERSION);
  });

  // ── LLM-facing sandbox parameters (#443) ────────────────────────────

  it('forwards caller-provided visiblePaths verbatim (pure replace)', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({ name: 'narrow', visiblePaths: ['/shared/docs/', '/mnt/context/'] });

    const created = onScoopScoop.mock.calls[0][0];
    expect(created.config?.visiblePaths).toEqual(['/shared/docs/', '/mnt/context/']);
  });

  it('accepts an empty visiblePaths array — read-nothing is explicit', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({ name: 'blind', visiblePaths: [] });

    const created = onScoopScoop.mock.calls[0][0];
    // Empty array must survive — NOT silently backfilled with the default.
    expect(created.config?.visiblePaths).toEqual([]);
  });

  it('forwards caller-provided writablePaths verbatim (pure replace)', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({
      name: 'scratch',
      writablePaths: ['/scoops/scratch-scoop/', '/tmp/'],
    });

    const created = onScoopScoop.mock.calls[0][0];
    expect(created.config?.writablePaths).toEqual(['/scoops/scratch-scoop/', '/tmp/']);
  });

  it('accepts an empty writablePaths array — read-only scoop', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({ name: 'read-only', writablePaths: [] });

    const created = onScoopScoop.mock.calls[0][0];
    expect(created.config?.writablePaths).toEqual([]);
  });

  it('forwards caller-provided allowedCommands verbatim', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({
      name: 'text-processor',
      allowedCommands: ['echo', 'cat', 'grep', 'sort'],
    });

    const created = onScoopScoop.mock.calls[0][0];
    expect(created.config?.allowedCommands).toEqual(['echo', 'cat', 'grep', 'sort']);
  });

  it('omits allowedCommands from config when the caller does not set it (unrestricted default)', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    await tool.execute({ name: 'default' });

    const created = onScoopScoop.mock.calls[0][0];
    // `undefined` tells the orchestrator+WasmShell "no restriction".
    // We deliberately don't stamp `['*']` here — omission is the canonical
    // "unrestricted" form across the stack.
    expect(created.config?.allowedCommands).toBeUndefined();
  });

  it('passes all three sandbox params through together with a model and prompt', async () => {
    const { tool, onScoopScoop } = findScoopScoopTool();
    const result = await tool.execute({
      name: 'combined',
      model: 'claude-sonnet-4-6',
      prompt: 'task',
      visiblePaths: ['/workspace/skills/'],
      writablePaths: ['/scoops/combined-scoop/'],
      allowedCommands: ['echo'],
    });

    const created = onScoopScoop.mock.calls[0][0];
    expect(created.config).toEqual({
      modelId: 'claude-sonnet-4-6',
      visiblePaths: ['/workspace/skills/'],
      writablePaths: ['/scoops/combined-scoop/'],
      allowedCommands: ['echo'],
    });
    expect(created.configSchemaVersion).toBe(CURRENT_SCOOP_CONFIG_VERSION);
    expect(result.isError).toBeUndefined();
  });
});
