import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage } from '../../src/core/types.js';
import type { ScoopContext } from '../../src/scoops/scoop-context.js';
import { ScoopCostTracker } from '../../src/scoops/scoop-cost-tracker.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

describe('ScoopCostTracker.getModelCosts', () => {
  function createMockScoop(jid: string, label: string, isCone = false): RegisteredScoop {
    return {
      jid,
      assistantLabel: label,
      isCone,
      tab: { id: `tab-${jid}`, type: 'scoop' as const, label },
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
    timestamp = Date.now()
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

  it('includes dropped scoops in the model aggregation', () => {
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

    const result = tracker.getModelCosts();

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
    expect(tracker.getModelCosts()).toHaveLength(1);

    tracker.reset();

    // After reset, should be empty
    expect(tracker.getModelCosts()).toEqual([]);
  });
});
