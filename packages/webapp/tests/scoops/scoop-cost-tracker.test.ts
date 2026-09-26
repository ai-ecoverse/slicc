import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage } from '../../src/core/types.js';
import type { ScoopContext } from '../../src/scoops/scoop-context.js';
import {
  BURN_RATE_MEDIUM_WEIGHT,
  BURN_RATE_MEDIUM_WINDOW_MS,
  BURN_RATE_MIN_SESSION_DURATION_MS,
  BURN_RATE_RECENT_WEIGHT,
  BURN_RATE_RECENT_WINDOW_MS,
  BURN_RATE_SESSION_WEIGHT,
  ScoopCostTracker,
} from '../../src/scoops/scoop-cost-tracker.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const MINUTE_MS = 60 * 1000;
const NOW_MS = 2_000_000_000_000;

describe('ScoopCostTracker', () => {
  function createMockScoop(
    jid: string,
    label: string,
    isCone = false,
    modelId?: string,
    extras: Partial<Pick<RegisteredScoop, 'parentJid' | 'notifyOnComplete'>> = {}
  ): RegisteredScoop {
    return {
      jid,
      assistantLabel: label,
      isCone,
      // Roots pin `parentJid: null` (isRootUnit). Non-cones leave it unset unless
      // the caller supplies one — an unset field is not a root.
      ...(isCone ? { parentJid: null } : {}),
      model: modelId ? { provider: 'bedrock-camp', id: modelId } : undefined,
      tab: { id: `tab-${jid}`, type: 'scoop' as const, label },
      ...extras,
    } as unknown as RegisteredScoop;
  }

  function createMockContext(messages: AssistantMessage[]): ScoopContext {
    return {
      getAgentMessages: () => messages,
    } as ScoopContext;
  }

  function createAssistantMessage(
    model: string,
    input: number,
    output: number,
    cacheRead = 0,
    cacheWrite = 0,
    inputCost = 0,
    outputCost = 0,
    cacheReadCost = 0,
    cacheWriteCost = 0,
    timestamp = NOW_MS
  ): AssistantMessage {
    const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
    return {
      role: 'assistant',
      model,
      timestamp,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: {
          input: inputCost,
          output: outputCost,
          cacheRead: cacheReadCost,
          cacheWrite: cacheWriteCost,
          total: totalCost,
        },
      },
    } as AssistantMessage;
  }

  let tracker: ScoopCostTracker;
  let scoopsMap: Map<string, RegisteredScoop>;
  let contextsMap: Map<string, ScoopContext>;

  beforeEach(() => {
    scoopsMap = new Map();
    contextsMap = new Map();
    tracker = new ScoopCostTracker({
      getScoops: () => scoopsMap,
      getContexts: () => contextsMap,
    });
  });

  function createCostMessage(cost: number, timestamp: number): AssistantMessage {
    return createAssistantMessage('model', 100, 50, 0, 0, cost, 0, 0, 0, timestamp);
  }

  function addLiveMessages(jid: string, messages: AssistantMessage[]): void {
    scoopsMap.set(jid, createMockScoop(jid, jid));
    contextsMap.set(jid, createMockContext(messages));
  }

  it('returns live session costs by default and includes dropped costs on request', () => {
    const liveScoop = createMockScoop('live', 'Live Scoop');
    const droppedScoop = createMockScoop('dropped', 'Dropped Scoop');
    scoopsMap.set('live', liveScoop);
    scoopsMap.set('dropped', droppedScoop);
    contextsMap.set(
      'live',
      createMockContext([createAssistantMessage('model-live', 100, 50, 0, 0, 0.01, 0.005)])
    );
    contextsMap.set(
      'dropped',
      createMockContext([createAssistantMessage('model-old', 200, 100, 0, 0, 0.02, 0.01)])
    );

    tracker.snapshot('dropped');
    scoopsMap.delete('dropped');
    contextsMap.delete('dropped');

    expect(tracker.getSessionCosts()).toMatchObject([
      { name: 'Live Scoop', source: 'live', models: ['model-live'] },
    ]);
    expect(tracker.getSessionCosts({ includeDropped: true })).toMatchObject([
      { name: 'Live Scoop', source: 'live' },
      { name: 'Dropped Scoop', source: 'dropped' },
    ]);
  });

  describe('silent agent one-shot fold into parent (#3437)', () => {
    /**
     * Mirrors the issue's controlled measurement: `cost --json` before an
     * `agent` one-shot, then again after the sub-scoop is torn down. The
     * spend must land on the invoking cone (tokens/cost/models), not vanish
     * and not appear only under `--all` as a separate dropped row.
     */
    it('attributes one-shot agent spend to the invoking cone after teardown', () => {
      const cone = createMockScoop('cone', 'sliccy', true, 'claude-opus-4-6');
      scoopsMap.set('cone', cone);
      contextsMap.set(
        'cone',
        createMockContext([
          createAssistantMessage('claude-opus-4-6', 100, 50, 0, 0, 0.1, 0.05, 0, 0, NOW_MS - 10),
        ])
      );

      const before = tracker.getSessionCosts();
      expect(before).toHaveLength(1);
      expect(before[0].name).toBe('sliccy');
      expect(before[0].turns).toBe(1);
      expect(before[0].models).toEqual(['claude-opus-4-6']);
      expect(before[0].usage.totalTokens).toBe(150);
      expect(before[0].usage.cost.total).toBeCloseTo(0.15, 10);

      // One-shot `agent` sub-scoop: silent, owned by the cone, different model.
      const agent = createMockScoop('agent_quiet_mint', 'agent-quiet-mint', false, undefined, {
        parentJid: 'cone',
        notifyOnComplete: false,
      });
      scoopsMap.set(agent.jid, agent);
      contextsMap.set(
        agent.jid,
        createMockContext([
          createAssistantMessage(
            'global.anthropic.claude-haiku-4-5-20251001-v1:0',
            200,
            40,
            0,
            0,
            0.002,
            0.001,
            0,
            0,
            NOW_MS
          ),
        ])
      );

      // Teardown path: snapshot while still registered, then remove (as unregister does).
      tracker.snapshot(agent.jid);
      scoopsMap.delete(agent.jid);
      contextsMap.delete(agent.jid);

      const after = tracker.getSessionCosts();
      expect(after).toHaveLength(1);
      expect(after[0].name).toBe('sliccy');
      expect(after[0].turns).toBe(2);
      expect(after[0].usage.totalTokens).toBe(150 + 240);
      expect(after[0].usage.cost.total).toBeCloseTo(0.153, 6);
      expect(after[0].models).toEqual(
        expect.arrayContaining([
          'claude-opus-4-6',
          'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        ])
      );
      // Model in use now stays the cone's pin — not the folded child's.
      expect(after[0].model).toBe('claude-opus-4-6');

      // No separate dropped row: `--all` must not double-count the fold.
      const all = tracker.getSessionCosts({ includeDropped: true });
      expect(all).toHaveLength(1);
      expect(all[0].usage.cost.total).toBeCloseTo(0.153, 6);

      // Per-model live aggregation sees the child's model without `--all`.
      const models = tracker.getModelCosts();
      expect(models.map((m) => m.model)).toEqual(
        expect.arrayContaining([
          'claude-opus-4-6',
          'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        ])
      );
    });

    it('still keeps a separate dropped row for a notifying child scoop', () => {
      const cone = createMockScoop('cone', 'sliccy', true, 'claude-opus-4-6');
      const child = createMockScoop('worker', 'worker', false, undefined, {
        parentJid: 'cone',
        notifyOnComplete: true,
      });
      scoopsMap.set('cone', cone);
      scoopsMap.set('worker', child);
      contextsMap.set(
        'cone',
        createMockContext([createAssistantMessage('claude-opus-4-6', 10, 5, 0, 0, 0.01, 0)])
      );
      contextsMap.set(
        'worker',
        createMockContext([createAssistantMessage('claude-haiku-4-5', 20, 10, 0, 0, 0.002, 0)])
      );

      tracker.snapshot('worker');
      scoopsMap.delete('worker');
      contextsMap.delete('worker');

      expect(tracker.getSessionCosts()).toMatchObject([
        { name: 'sliccy', turns: 1, usage: { cost: { total: 0.01 } } },
      ]);
      expect(tracker.getSessionCosts({ includeDropped: true })).toMatchObject([
        { name: 'sliccy', source: 'live' },
        { name: 'worker', source: 'dropped', models: ['claude-haiku-4-5'] },
      ]);
    });

    it('creates a parent cost row from folded spend when the parent has no turns yet', () => {
      const cone = createMockScoop('cone', 'sliccy', true, 'claude-opus-4-6');
      scoopsMap.set('cone', cone);
      contextsMap.set('cone', createMockContext([]));

      expect(tracker.getSessionCosts()).toEqual([]);

      const agent = createMockScoop('agent_x', 'agent-x', false, undefined, {
        parentJid: 'cone',
        notifyOnComplete: false,
      });
      scoopsMap.set(agent.jid, agent);
      contextsMap.set(
        agent.jid,
        createMockContext([createAssistantMessage('claude-haiku-4-5', 50, 10, 0, 0, 0.001, 0)])
      );
      tracker.snapshot(agent.jid);
      scoopsMap.delete(agent.jid);
      contextsMap.delete(agent.jid);

      const after = tracker.getSessionCosts();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        name: 'sliccy',
        turns: 1,
        models: ['claude-haiku-4-5'],
        usage: { totalTokens: 60, cost: { total: 0.001 } },
      });
    });
  });

  it('reports the model in use now and collapses alias spellings of one model', () => {
    const scoop = createMockScoop('cone', 'sliccy', true, 'global.anthropic.claude-opus-5');
    scoopsMap.set('cone', scoop);
    contextsMap.set(
      'cone',
      createMockContext([
        createAssistantMessage('presto', 100, 50, 0, 0, 0.2, 0, 0, 0, NOW_MS - 3),
        createAssistantMessage('presto', 100, 50, 0, 0, 0.2, 0, 0, 0, NOW_MS - 2),
        createAssistantMessage('claude-opus-5', 100, 50, 0, 0, 0.05, 0, 0, 0, NOW_MS - 1),
        createAssistantMessage(
          'global.anthropic.claude-opus-5',
          100,
          50,
          0,
          0,
          0.05,
          0,
          0,
          0,
          NOW_MS
        ),
      ])
    );

    const [cost] = tracker.getSessionCosts();

    // Most turns were presto. The pin is the model in use now, and the two
    // opus spellings are one model, reported under the pin's spelling.
    expect(cost.model).toBe('global.anthropic.claude-opus-5');
    expect(cost.models).toEqual(['presto', 'global.anthropic.claude-opus-5']);
  });

  it('uses the latest turn when the unit has no pinned model', () => {
    const scoop = createMockScoop('multi', 'Multi-model Scoop');
    scoopsMap.set('multi', scoop);
    contextsMap.set(
      'multi',
      createMockContext([
        createAssistantMessage('model-frequent', 100, 50, 0, 0, 0.01, 0, 0, 0, NOW_MS - 2),
        createAssistantMessage('model-frequent', 100, 50, 0, 0, 0.01, 0, 0, 0, NOW_MS - 1),
        createAssistantMessage('model-expensive', 100, 50, 0, 0, 0.1, 0, 0, 0, NOW_MS),
      ])
    );

    const [cost] = tracker.getSessionCosts();

    expect(cost.model).toBe('model-expensive');
    expect(cost.models).toEqual(['model-expensive', 'model-frequent']);
  });

  it('collapses a dated Bedrock id with its bare alias', () => {
    const scoop = createMockScoop(
      'haiku',
      'loose-ends',
      false,
      'anthropic.claude-haiku-4-5-20251001-v1:0'
    );
    scoopsMap.set('haiku', scoop);
    contextsMap.set(
      'haiku',
      createMockContext([
        createAssistantMessage('claude-haiku-4-5', 100, 50, 0, 0, 0.01, 0, 0, 0, NOW_MS - 1),
        createAssistantMessage(
          'anthropic.claude-haiku-4-5-20251001-v1:0',
          100,
          50,
          0,
          0,
          0.02,
          0,
          0,
          0,
          NOW_MS
        ),
      ])
    );

    const [cost] = tracker.getSessionCosts();

    expect(cost.model).toBe('anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(cost.models).toEqual(['anthropic.claude-haiku-4-5-20251001-v1:0']);
  });

  it('does not treat a speed variant as the same model', () => {
    const scoop = createMockScoop('fast', 'Fast');
    scoopsMap.set('fast', scoop);
    contextsMap.set(
      'fast',
      createMockContext([
        createAssistantMessage('claude-opus-5', 100, 50, 0, 0, 0.05),
        createAssistantMessage('anthropic/claude-opus-5-fast', 100, 50, 0, 0, 0.08),
      ])
    );

    const [cost] = tracker.getSessionCosts();

    expect(cost.models).toEqual(['anthropic/claude-opus-5-fast', 'claude-opus-5']);
  });

  it('reports the latest turn when a provider-less legacy pin is a different model', () => {
    const scoop = createMockScoop('legacy', 'Legacy');
    scoop.config = { modelId: 'gpt-4.1' };
    scoopsMap.set('legacy', scoop);
    contextsMap.set(
      'legacy',
      createMockContext([
        createAssistantMessage('presto', 100, 50, 0, 0, 0.2, 0, 0, 0, NOW_MS - 2),
        createAssistantMessage('presto', 100, 50, 0, 0, 0.2, 0, 0, 0, NOW_MS - 1),
        createAssistantMessage('claude-opus-5', 100, 50, 0, 0, 0.05, 0, 0, 0, NOW_MS),
      ])
    );

    const [cost] = tracker.getSessionCosts();

    expect(cost.model).toBe('claude-opus-5');
  });

  it('keeps a provider-less pin when it is the same model as the latest turn', () => {
    const scoop = createMockScoop('legacy-same', 'Legacy same');
    scoop.config = { modelId: 'claude-opus-5' };
    scoopsMap.set('legacy-same', scoop);
    contextsMap.set(
      'legacy-same',
      createMockContext([
        createAssistantMessage(
          'global.anthropic.claude-opus-5',
          100,
          50,
          0,
          0,
          0.05,
          0,
          0,
          0,
          NOW_MS
        ),
      ])
    );

    const [cost] = tracker.getSessionCosts();

    expect(cost.model).toBe('claude-opus-5');
    expect(cost.models).toEqual(['claude-opus-5']);
  });

  describe('burn rate', () => {
    it('exports the configured windows, floor, and weights', () => {
      expect(BURN_RATE_RECENT_WINDOW_MS).toBe(15 * MINUTE_MS);
      expect(BURN_RATE_MEDIUM_WINDOW_MS).toBe(60 * MINUTE_MS);
      expect(BURN_RATE_MIN_SESSION_DURATION_MS).toBe(MINUTE_MS);
      expect(BURN_RATE_RECENT_WEIGHT).toBe(0.5);
      expect(BURN_RATE_MEDIUM_WEIGHT).toBe(0.3);
      expect(BURN_RATE_SESSION_WEIGHT).toBe(0.2);
    });

    it('returns zero for an empty session', () => {
      addLiveMessages('empty', []);

      expect(tracker.getBurnRate(NOW_MS)).toBe(0);
    });

    it('reports the true hourly average for steady spend', () => {
      const messages = Array.from({ length: 120 }, (_, index) =>
        createCostMessage(0.01, NOW_MS - (120 - index) * MINUTE_MS)
      );
      addLiveMessages('steady', messages);

      expect(tracker.getBurnRate(NOW_MS)).toBeCloseTo(0.6, 10);
    });

    it('uses the one-minute floor for a single early turn', () => {
      addLiveMessages('early', [createCostMessage(0.01, NOW_MS)]);

      expect(tracker.getBurnRate(NOW_MS)).toBeCloseTo(0.6, 10);
    });

    it('stops at the session average after 20 minutes idle', () => {
      addLiveMessages('idle', [
        createCostMessage(1, NOW_MS - 40 * MINUTE_MS),
        createCostMessage(1, NOW_MS - 20 * MINUTE_MS),
      ]);

      expect(tracker.getBurnRate(NOW_MS)).toBeCloseTo(3, 10);
    });

    it('never drops below the session average after a burst then idle period', () => {
      addLiveMessages('burst', [
        createCostMessage(0.1, NOW_MS - 120 * MINUTE_MS),
        createCostMessage(10, NOW_MS - 16 * MINUTE_MS),
      ]);
      const sessionRate = 10.1 / 2;
      const rate = tracker.getBurnRate(NOW_MS);

      expect(rate).toBeGreaterThanOrEqual(sessionRate);
      expect(rate).toBeCloseTo(sessionRate, 10);
    });

    it('includes dropped-scoop messages in every component', () => {
      addLiveMessages('dropped', [
        createCostMessage(1, NOW_MS - 120 * MINUTE_MS),
        createCostMessage(1, NOW_MS - 5 * MINUTE_MS),
      ]);
      tracker.snapshot('dropped');
      scoopsMap.delete('dropped');
      contextsMap.delete('dropped');

      expect(tracker.getBurnRate(NOW_MS)).toBeCloseTo(2.5, 10);
    });

    it('clamps trailing windows to the elapsed session duration', () => {
      addLiveMessages('clamped', [
        createCostMessage(0.05, NOW_MS - 5 * MINUTE_MS),
        createCostMessage(0.05, NOW_MS - MINUTE_MS),
      ]);

      expect(tracker.getBurnRate(NOW_MS)).toBeCloseTo(1.2, 10);
    });
  });

  it('aggregates costs by model across all live scoops', () => {
    const scoop1 = createMockScoop('scoop1', 'Scoop 1');
    const scoop2 = createMockScoop('scoop2', 'Scoop 2');

    const messages1 = [
      createAssistantMessage('claude-opus-4-6', 1000, 500, 0, 0, 0.01, 0.005),
      createAssistantMessage('claude-opus-4-6', 2000, 1000, 0, 0, 0.02, 0.01),
      createAssistantMessage('claude-sonnet-4-5', 500, 250, 0, 0, 0.002, 0.001),
    ];

    const messages2 = [
      createAssistantMessage('claude-opus-4-6', 1500, 750, 0, 0, 0.015, 0.0075),
      createAssistantMessage('claude-sonnet-4-5', 1000, 500, 0, 0, 0.004, 0.002),
    ];

    scoopsMap.set('scoop1', scoop1);
    scoopsMap.set('scoop2', scoop2);
    contextsMap.set('scoop1', createMockContext(messages1));
    contextsMap.set('scoop2', createMockContext(messages2));

    const result = tracker.getModelCosts();

    expect(result).toHaveLength(2);

    const opus = result.find((r) => r.model === 'claude-opus-4-6');
    expect(opus).toBeDefined();
    expect(opus!.input).toBe(4500); // 1000 + 2000 + 1500
    expect(opus!.output).toBe(2250); // 500 + 1000 + 750
    expect(opus!.cost).toBeCloseTo(0.0675, 4); // (0.01 + 0.005) + (0.02 + 0.01) + (0.015 + 0.0075)
    expect(opus!.turns).toBe(3);

    const sonnet = result.find((r) => r.model === 'claude-sonnet-4-5');
    expect(sonnet).toBeDefined();
    expect(sonnet!.input).toBe(1500); // 500 + 1000
    expect(sonnet!.output).toBe(750); // 250 + 500
    expect(sonnet!.cost).toBeCloseTo(0.009, 4); // 0.002 + 0.001 + 0.004 + 0.002
    expect(sonnet!.turns).toBe(2);
  });

  it('includes dropped scoops in the model aggregation only on request', () => {
    const scoop1 = createMockScoop('scoop1', 'Live Scoop');
    const scoop2 = createMockScoop('scoop2', 'Dropped Scoop');

    const liveMessages = [createAssistantMessage('claude-opus-4-6', 1000, 500, 0, 0, 0.01, 0.005)];

    const droppedMessages = [
      createAssistantMessage('claude-opus-4-6', 2000, 1000, 0, 0, 0.02, 0.01),
      createAssistantMessage('claude-sonnet-4-5', 500, 250, 0, 0, 0.002, 0.001),
    ];

    scoopsMap.set('scoop1', scoop1);
    scoopsMap.set('scoop2', scoop2);
    contextsMap.set('scoop1', createMockContext(liveMessages));
    contextsMap.set('scoop2', createMockContext(droppedMessages));

    // Snapshot scoop2 before removing it
    tracker.snapshot('scoop2');
    scoopsMap.delete('scoop2');
    contextsMap.delete('scoop2');

    expect(tracker.getModelCosts()).toMatchObject([
      { model: 'claude-opus-4-6', input: 1000, output: 500 },
    ]);

    const result = tracker.getModelCosts({ includeDropped: true });

    expect(result).toHaveLength(2);

    const opus = result.find((r) => r.model === 'claude-opus-4-6');
    expect(opus).toBeDefined();
    expect(opus!.input).toBe(3000); // 1000 + 2000
    expect(opus!.output).toBe(1500); // 500 + 1000
    expect(opus!.cost).toBeCloseTo(0.045, 4); // 0.01 + 0.005 + 0.02 + 0.01

    const sonnet = result.find((r) => r.model === 'claude-sonnet-4-5');
    expect(sonnet).toBeDefined();
    expect(sonnet!.input).toBe(500);
    expect(sonnet!.output).toBe(250);
    expect(sonnet!.cost).toBeCloseTo(0.003, 4);
  });

  it('sorts results by cost descending', () => {
    const scoop1 = createMockScoop('scoop1', 'Scoop 1');

    const messages = [
      createAssistantMessage('model-cheap', 100, 50, 0, 0, 0.001, 0.0005),
      createAssistantMessage('model-expensive', 1000, 500, 0, 0, 0.1, 0.05),
      createAssistantMessage('model-medium', 500, 250, 0, 0, 0.01, 0.005),
    ];

    scoopsMap.set('scoop1', scoop1);
    contextsMap.set('scoop1', createMockContext(messages));

    const result = tracker.getModelCosts();

    expect(result).toHaveLength(3);
    expect(result[0].model).toBe('model-expensive');
    expect(result[0].cost).toBeCloseTo(0.15, 4);
    expect(result[1].model).toBe('model-medium');
    expect(result[1].cost).toBeCloseTo(0.015, 4);
    expect(result[2].model).toBe('model-cheap');
    expect(result[2].cost).toBeCloseTo(0.0015, 4);
  });

  it('merges bare and qualified spellings of one model and leaves unrelated ids apart', () => {
    addLiveMessages('opus', [
      createAssistantMessage('claude-opus-5', 100, 50, 0, 0, 0.01),
      createAssistantMessage('global.anthropic.claude-opus-5', 200, 50, 0, 0, 0.02),
      createAssistantMessage('claude-haiku-4-5', 10, 5, 0, 0, 0.001),
      createAssistantMessage('anthropic.claude-haiku-4-5-20251001-v1:0', 10, 5, 0, 0, 0.001),
      createAssistantMessage('grok-4.6', 10, 5, 0, 0, 0.003),
      createAssistantMessage('grok-4.5', 10, 5, 0, 0, 0.004),
      createAssistantMessage('anthropic/claude-opus-5-fast', 10, 5, 0, 0, 0.005),
    ]);

    const result = tracker.getModelCosts();
    const byModel = new Map(result.map((row) => [row.model, row]));

    expect(byModel.get('claude-opus-5')).toMatchObject({ input: 300, turns: 2 });
    expect(byModel.get('claude-haiku-4-5')).toMatchObject({ input: 20, turns: 2 });
    expect(byModel.get('grok-4.6')).toMatchObject({ turns: 1 });
    expect(byModel.get('grok-4.5')).toMatchObject({ turns: 1 });
    expect(byModel.get('anthropic/claude-opus-5-fast')).toMatchObject({ turns: 1 });
    expect(byModel.has('global.anthropic.claude-opus-5')).toBe(false);
  });

  it('returns empty array when no usage exists', () => {
    const scoop1 = createMockScoop('scoop1', 'Empty Scoop');
    scoopsMap.set('scoop1', scoop1);
    contextsMap.set('scoop1', createMockContext([]));

    const result = tracker.getModelCosts();

    expect(result).toEqual([]);
  });

  it('handles cache tokens correctly', () => {
    const scoop1 = createMockScoop('scoop1', 'Cached Scoop');

    const messages = [
      createAssistantMessage('claude-opus-4-6', 1000, 500, 2000, 1000, 0.01, 0.005, 0.001, 0.002),
    ];

    scoopsMap.set('scoop1', scoop1);
    contextsMap.set('scoop1', createMockContext(messages));

    const result = tracker.getModelCosts();

    expect(result).toHaveLength(1);
    expect(result[0].cacheRead).toBe(2000);
    expect(result[0].cacheWrite).toBe(1000);
    expect(result[0].cost).toBeCloseTo(0.018, 4); // 0.01 + 0.005 + 0.001 + 0.002
  });

  it('clears dropped messages on reset', () => {
    const scoop1 = createMockScoop('scoop1', 'Dropped Scoop');
    const messages = [createAssistantMessage('claude-opus-4-6', 1000, 500, 0, 0, 0.01, 0.005)];

    scoopsMap.set('scoop1', scoop1);
    contextsMap.set('scoop1', createMockContext(messages));

    tracker.snapshot('scoop1');
    scoopsMap.delete('scoop1');
    contextsMap.delete('scoop1');

    // Should have one model from dropped scoop
    expect(tracker.getModelCosts({ includeDropped: true })).toHaveLength(1);

    tracker.reset();

    // After reset, should be empty
    expect(tracker.getModelCosts({ includeDropped: true })).toEqual([]);
  });
});
