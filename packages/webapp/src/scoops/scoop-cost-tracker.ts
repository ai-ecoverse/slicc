/**
 * Per-session cost tracking for the `cost` shell command.
 *
 * Aggregates per-scoop usage from each context's assistant messages and
 * preserves costs for scoops that have been dropped within the current
 * session so the cone can still see the total spend (PR #1091 extracted this
 * out of Orchestrator to keep that class focused on lifecycle).
 *
 * The tracker is intentionally read-mostly — it doesn't subscribe to scoop
 * events. The orchestrator calls {@link snapshot} once on unregister, and the
 * `cost` shell command reads {@link getSessionCosts} on demand.
 */

import type { AssistantMessage } from '../core/types.js';
import type { ScoopCostData } from '../shell/supplemental-commands/cost-command.js';
import type { ScoopContext } from './scoop-context.js';
import type { RegisteredScoop } from './types.js';

export interface ModelCostData {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface ScoopCostTrackerDeps {
  /** Live registered scoops (cone + non-cone), keyed by jid. */
  getScoops(): ReadonlyMap<string, RegisteredScoop>;
  /** Live scoop contexts keyed by jid. */
  getContexts(): ReadonlyMap<string, ScoopContext>;
}

/**
 * Build cost data for a single scoop from its context's assistant messages.
 * Returns `null` when the scoop has no usage yet (no assistant turns).
 *
 * Active time is rounded up to 15-minute intervals so a long-idle scoop with
 * a handful of turns doesn't read as "zero minutes" in the `cost` table.
 */
export function buildScoopCost(
  scoop: RegisteredScoop,
  context: ScoopContext
): ScoopCostData | null {
  const messages = context.getAgentMessages();
  const assistantMsgs = messages.filter((m): m is AssistantMessage => m.role === 'assistant');
  if (assistantMsgs.length === 0) return null;

  const aggregated = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const modelCounts = new Map<string, number>();
  for (const msg of assistantMsgs) {
    aggregated.input += msg.usage.input;
    aggregated.output += msg.usage.output;
    aggregated.cacheRead += msg.usage.cacheRead;
    aggregated.cacheWrite += msg.usage.cacheWrite;
    aggregated.totalTokens += msg.usage.totalTokens;
    aggregated.cost.input += msg.usage.cost.input;
    aggregated.cost.output += msg.usage.cost.output;
    aggregated.cost.cacheRead += msg.usage.cost.cacheRead;
    aggregated.cost.cacheWrite += msg.usage.cost.cacheWrite;
    aggregated.cost.total += msg.usage.cost.total;
    modelCounts.set(msg.model, (modelCounts.get(msg.model) ?? 0) + 1);
  }

  let topModel = '';
  let topCount = 0;
  for (const [model, count] of modelCounts) {
    if (count > topCount) {
      topModel = model;
      topCount = count;
    }
  }

  const timestamps = assistantMsgs.map((m) => m.timestamp).sort((a, b) => a - b);
  const firstActivity = timestamps[0];
  const lastActivity = timestamps[timestamps.length - 1];

  const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
  const timespanMs = lastActivity - firstActivity;
  const intervals = Math.max(1, Math.ceil(timespanMs / FIFTEEN_MINUTES_MS));
  const activeTimeMs = intervals * FIFTEEN_MINUTES_MS;

  return {
    name: scoop.assistantLabel,
    type: scoop.isCone ? 'cone' : 'scoop',
    model: topModel,
    usage: aggregated,
    turns: assistantMsgs.length,
    firstActivity,
    lastActivity,
    activeTimeMs,
  };
}

export class ScoopCostTracker {
  /** Preserves cost data for scoops that have been dropped this session. */
  private dropped: ScoopCostData[] = [];
  /** Preserves assistant messages for dropped scoops to enable per-model aggregation. */
  private droppedMessages: AssistantMessage[][] = [];
  private readonly deps: ScoopCostTrackerDeps;

  constructor(deps: ScoopCostTrackerDeps) {
    this.deps = deps;
  }

  /** Snapshot a scoop's cost data before it is destroyed. */
  snapshot(jid: string): void {
    const scoop = this.deps.getScoops().get(jid);
    const context = this.deps.getContexts().get(jid);
    if (!scoop || !context) return;
    const costData = buildScoopCost(scoop, context);
    if (costData) {
      this.dropped.push(costData);
    }
    const messages = context.getAgentMessages();
    const assistantMsgs = messages.filter((m): m is AssistantMessage => m.role === 'assistant');
    if (assistantMsgs.length > 0) {
      this.droppedMessages.push(assistantMsgs);
    }
  }

  /** Collect cost data from all active + dropped scoops for the `cost` command. */
  getSessionCosts(): ScoopCostData[] {
    const results: ScoopCostData[] = [];
    const contexts = this.deps.getContexts();
    for (const scoop of this.deps.getScoops().values()) {
      const context = contexts.get(scoop.jid);
      if (!context) continue;
      const costData = buildScoopCost(scoop, context);
      if (costData) results.push(costData);
    }
    results.push(...this.dropped);
    return results;
  }

  /**
   * Per-scoop context-window fill (0..1), from each scoop's last assistant
   * turn. Drives the chip pupils — they dilate as the context fills up.
   */
  getContextFills(): Array<{ jid: string; fill: number }> {
    return [...this.deps.getContexts().entries()].map(([jid, context]) => ({
      jid,
      fill: context.getContextFill(),
    }));
  }

  /**
   * Aggregate token usage and cost across all live + dropped scoops, grouped by model name.
   * Returns results sorted by cost descending.
   */
  getModelCosts(): ModelCostData[] {
    const modelMap = new Map<string, ModelCostData>();

    // Aggregate live scoops
    const contexts = this.deps.getContexts();
    for (const context of contexts.values()) {
      const messages = context.getAgentMessages();
      const assistantMsgs = messages.filter((m): m is AssistantMessage => m.role === 'assistant');
      this.aggregateMessages(assistantMsgs, modelMap);
    }

    // Aggregate dropped scoops
    for (const messages of this.droppedMessages) {
      this.aggregateMessages(messages, modelMap);
    }

    // Convert to array and sort by cost descending
    return Array.from(modelMap.values()).sort((a, b) => b.cost - a.cost);
  }

  /** Helper to aggregate messages into the model map. */
  private aggregateMessages(
    messages: AssistantMessage[],
    modelMap: Map<string, ModelCostData>
  ): void {
    for (const msg of messages) {
      const existing = modelMap.get(msg.model);
      if (existing) {
        existing.input += msg.usage.input;
        existing.output += msg.usage.output;
        existing.cacheRead += msg.usage.cacheRead;
        existing.cacheWrite += msg.usage.cacheWrite;
        existing.cost += msg.usage.cost.total;
        existing.turns += 1;
      } else {
        modelMap.set(msg.model, {
          model: msg.model,
          input: msg.usage.input,
          output: msg.usage.output,
          cacheRead: msg.usage.cacheRead,
          cacheWrite: msg.usage.cacheWrite,
          cost: msg.usage.cost.total,
          turns: 1,
        });
      }
    }
  }

  /** Drop all preserved cost data (e.g. on filesystem reset or clear-all). */
  reset(): void {
    this.dropped = [];
    this.droppedMessages = [];
  }
}
