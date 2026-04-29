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

describe('scoop_mute / scoop_unmute / scoop_wait tools', () => {
  const targetScoop: RegisteredScoop = {
    jid: 'scoop_alpha_1',
    name: 'alpha',
    folder: 'alpha-scoop',
    isCone: false,
    type: 'scoop',
    requiresTrigger: true,
    assistantLabel: 'alpha-scoop',
    addedAt: new Date().toISOString(),
  };

  function buildConeTools(
    options: {
      unmuteReturns?: Array<{
        jid: string;
        summary: string;
        timestamp: string;
        notificationPath: string | null;
      }>;
    } = {}
  ) {
    const onMuteScoops = vi.fn();
    const onUnmuteScoops = vi.fn(async () => options.unmuteReturns ?? []);
    const onScheduleScoopWait = vi.fn((jids: readonly string[]) => ({
      scheduled: [...jids],
      unknown: [],
    }));
    const tools = createScoopManagementTools({
      scoop: cone,
      onSendMessage: vi.fn(),
      getScoops: () => [cone, targetScoop],
      onMuteScoops,
      onUnmuteScoops,
      onScheduleScoopWait,
    });
    return { tools, onMuteScoops, onUnmuteScoops, onScheduleScoopWait };
  }

  it('scoop_mute forwards resolved jids and reports unknown names', async () => {
    const { tools, onMuteScoops } = buildConeTools();
    const tool = tools.find((t) => t.name === 'scoop_mute');
    expect(tool).toBeDefined();

    const result = await tool!.execute({ scoop_names: ['alpha-scoop', 'ghost'] });
    expect(onMuteScoops).toHaveBeenCalledWith([targetScoop.jid]);
    expect(result.content).toContain('Muted: alpha-scoop');
    expect(result.content).toContain('unknown: ghost');
  });

  it('scoop_mute rejects an empty list', async () => {
    const { tools, onMuteScoops } = buildConeTools();
    const tool = tools.find((t) => t.name === 'scoop_mute');
    const result = await tool!.execute({ scoop_names: [] });
    expect(result.isError).toBe(true);
    expect(onMuteScoops).not.toHaveBeenCalled();
  });

  it('scoop_mute reports an error when every name is unknown', async () => {
    const { tools, onMuteScoops } = buildConeTools();
    const tool = tools.find((t) => t.name === 'scoop_mute');
    const result = await tool!.execute({ scoop_names: ['missing'] });
    expect(result.isError).toBe(true);
    expect(onMuteScoops).not.toHaveBeenCalled();
  });

  it('scoop_unmute forwards resolved jids and reports no stashed completions when empty', async () => {
    const { tools, onUnmuteScoops } = buildConeTools();
    const tool = tools.find((t) => t.name === 'scoop_unmute');
    expect(tool).toBeDefined();

    const result = await tool!.execute({ scoop_names: ['alpha-scoop'] });
    expect(onUnmuteScoops).toHaveBeenCalledWith([targetScoop.jid]);
    expect(result.content).toContain('Unmuted: alpha-scoop');
    expect(result.content).toContain('No stashed completions');
  });

  it('scoop_unmute folds stashed completions into the tool result', async () => {
    // The whole point of scoop_mute/scoop_unmute is that the cone reads
    // stashed summaries in the CURRENT turn. Returning them in the tool
    // result (instead of re-firing them as new lick events) is what
    // makes that possible — otherwise unmute would just re-trigger a
    // fresh cone turn, defeating the mute.
    const { tools, onUnmuteScoops } = buildConeTools({
      unmuteReturns: [
        {
          jid: targetScoop.jid,
          summary: 'scoop wrote hero block',
          timestamp: '2026-01-01T00:00:00.000Z',
          notificationPath: '/shared/scoop-notifications/2026-01-01T00-00-00-000Z-alpha.md',
        },
      ],
    });
    const tool = tools.find((t) => t.name === 'scoop_unmute');
    const result = await tool!.execute({ scoop_names: ['alpha-scoop'] });
    expect(onUnmuteScoops).toHaveBeenCalledWith([targetScoop.jid]);
    expect(result.content).toContain('Unmuted: alpha-scoop');
    expect(result.content).toContain('Stashed completions');
    expect(result.content).toContain('--- alpha-scoop ---');
    expect(result.content).toContain('scoop wrote hero block');
    expect(result.content).toContain(
      'VFS path: /shared/scoop-notifications/2026-01-01T00-00-00-000Z-alpha.md'
    );
  });

  it('scoop_wait schedules a non-blocking wait and returns immediately', async () => {
    // The whole point of the refactor: scoop_wait MUST NOT freeze the
    // cone. The tool returns a synchronous acknowledgement and the
    // orchestrator delivers a `scoop-wait` lick later when the wait
    // resolves. The mock `onScheduleScoopWait` is intentionally sync —
    // wrapping its call in a never-resolving promise here would still
    // return immediately because the tool no longer awaits the result.
    const { tools, onScheduleScoopWait } = buildConeTools();
    const tool = tools.find((t) => t.name === 'scoop_wait');
    expect(tool).toBeDefined();

    const start = Date.now();
    const result = await tool!.execute({ scoop_names: ['alpha-scoop'], timeout_ms: 1000 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
    expect(onScheduleScoopWait).toHaveBeenCalledWith([targetScoop.jid], 1000);
    expect(result.content).toContain('scoop_wait scheduled for: alpha-scoop');
    expect(result.content).toContain('timeout: 1000ms');
    expect(result.content).toContain("'scoop-wait' lick");
    expect(result.isError).toBeUndefined();
  });

  it('scoop_wait reports unknown names but still schedules known ones', async () => {
    const { tools, onScheduleScoopWait } = buildConeTools();
    const tool = tools.find((t) => t.name === 'scoop_wait');

    const result = await tool!.execute({ scoop_names: ['alpha-scoop', 'ghost'] });
    expect(onScheduleScoopWait).toHaveBeenCalledWith([targetScoop.jid], undefined);
    expect(result.content).toContain('scoop_wait scheduled for: alpha-scoop');
    expect(result.content).toContain('no timeout');
    expect(result.content).toContain('Unknown (skipped): ghost');
  });

  it('scoop_wait surfaces scoops dropped between resolve and schedule', async () => {
    // Race: the scoop existed when resolveScoopNames ran but was
    // dropped before the orchestrator could install the wait. The
    // orchestrator reports it back via `unknown`; the tool must use
    // that — not the resolved list — to build the ack so the cone
    // doesn't believe the wait is active for a vanished scoop.
    const onScheduleScoopWait = vi.fn(() => ({
      scheduled: [],
      unknown: [targetScoop.jid],
    }));
    const tools = createScoopManagementTools({
      scoop: cone,
      onSendMessage: vi.fn(),
      getScoops: () => [cone, targetScoop],
      onMuteScoops: vi.fn(),
      onUnmuteScoops: vi.fn(async () => []),
      onScheduleScoopWait,
    });
    const tool = tools.find((t) => t.name === 'scoop_wait');
    const result = await tool!.execute({ scoop_names: ['alpha-scoop'] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('could not be scheduled');
    expect(result.content).toContain('alpha-scoop');
  });

  it('scoop_wait reports partial schedule when some jids are dropped', async () => {
    const otherScoop: RegisteredScoop = {
      ...targetScoop,
      jid: 'scoop_beta_1',
      name: 'beta',
      folder: 'beta-scoop',
      assistantLabel: 'beta-scoop',
    };
    const onScheduleScoopWait = vi.fn(() => ({
      scheduled: [targetScoop.jid],
      unknown: [otherScoop.jid],
    }));
    const tools = createScoopManagementTools({
      scoop: cone,
      onSendMessage: vi.fn(),
      getScoops: () => [cone, targetScoop, otherScoop],
      onMuteScoops: vi.fn(),
      onUnmuteScoops: vi.fn(async () => []),
      onScheduleScoopWait,
    });
    const tool = tools.find((t) => t.name === 'scoop_wait');
    const result = await tool!.execute({
      scoop_names: ['alpha-scoop', 'beta-scoop'],
      timeout_ms: 500,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('scoop_wait scheduled for: alpha-scoop');
    expect(result.content).toContain('timeout: 500ms');
    expect(result.content).toContain('Dropped before schedule (skipped): beta-scoop');
  });

  it('scoop_wait rejects non-finite or negative timeouts', async () => {
    const { tools, onScheduleScoopWait } = buildConeTools();
    const tool = tools.find((t) => t.name === 'scoop_wait');
    const neg = await tool!.execute({ scoop_names: ['alpha-scoop'], timeout_ms: -5 });
    expect(neg.isError).toBe(true);
    const nan = await tool!.execute({ scoop_names: ['alpha-scoop'], timeout_ms: Number.NaN });
    expect(nan.isError).toBe(true);
    expect(onScheduleScoopWait).not.toHaveBeenCalled();
  });

  it('mute/unmute/wait tools are absent on non-cone scoops', async () => {
    const nonCone: RegisteredScoop = { ...targetScoop, isCone: false, type: 'scoop' };
    const tools = createScoopManagementTools({
      scoop: nonCone,
      onSendMessage: vi.fn(),
      getScoops: () => [cone, nonCone],
      onMuteScoops: vi.fn(),
      onUnmuteScoops: vi.fn(async () => []),
      onScheduleScoopWait: vi.fn(() => ({ scheduled: [], unknown: [] })),
    });
    expect(tools.find((t) => t.name === 'scoop_mute')).toBeUndefined();
    expect(tools.find((t) => t.name === 'scoop_unmute')).toBeUndefined();
    expect(tools.find((t) => t.name === 'scoop_wait')).toBeUndefined();
  });
});
