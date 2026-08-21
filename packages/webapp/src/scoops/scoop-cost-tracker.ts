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
import { isRootUnit } from '../work-unit/policy.js';
import type { ScoopContext } from './scoop-context.js';
import type { RegisteredScoop } from './types.js';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

export const BURN_RATE_RECENT_WINDOW_MS = FIFTEEN_MINUTES_MS;
export const BURN_RATE_MEDIUM_WINDOW_MS = 60 * 60 * 1000;
export const BURN_RATE_MIN_SESSION_DURATION_MS = 60 * 1000;
export const BURN_RATE_RECENT_WEIGHT = 0.5;
export const BURN_RATE_MEDIUM_WEIGHT = 0.3;
export const BURN_RATE_SESSION_WEIGHT = 0.2;

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

export interface CostScopeOptions {
  includeDropped?: boolean;
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
  context: ScoopContext,
  source: ScoopCostData['source'] = 'live'
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
  const modelCosts = new Map<string, number>();
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
    modelCosts.set(msg.model, (modelCosts.get(msg.model) ?? 0) + msg.usage.cost.total);
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

  const timespanMs = lastActivity - firstActivity;
  const intervals = Math.max(1, Math.ceil(timespanMs / FIFTEEN_MINUTES_MS));
  const activeTimeMs = intervals * FIFTEEN_MINUTES_MS;

  return {
    name: scoop.assistantLabel,
    type: isRootUnit(scoop) ? 'cone' : 'scoop',
    model: topModel,
    models: [...modelCosts.entries()]
      .sort(([, costA], [, costB]) => costB - costA)
      .map(([model]) => model),
    source,
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
    const costData = buildScoopCost(scoop, context, 'dropped');
    if (costData) {
      this.dropped.push(costData);
    }
    const messages = context.getAgentMessages();
    const assistantMsgs = messages.filter((m): m is AssistantMessage => m.role === 'assistant');
    if (assistantMsgs.length > 0) {
      this.droppedMessages.push(assistantMsgs);
    }
  }

  /** Collect cost data from live scoops, optionally including dropped history. */
  getSessionCosts(options: CostScopeOptions = {}): ScoopCostData[] {
    const results: ScoopCostData[] = [];
    const contexts = this.deps.getContexts();
    for (const scoop of this.deps.getScoops().values()) {
      const context = contexts.get(scoop.jid);
      if (!context) continue;
      const costData = buildScoopCost(scoop, context);
      if (costData) results.push(costData);
    }
    if (options.includeDropped) results.push(...this.dropped);
    return results;
  }

  /**
   * Weighted USD/hour blend of trailing 15-minute, trailing 60-minute, and
   * full-session spend, floored at the full-session average.
   */
  getBurnRate(nowMs = Date.now()): number {
    const assistantMessages = this.droppedMessages.flat();
    for (const context of this.deps.getContexts().values()) {
      for (const message of context.getAgentMessages()) {
        if (message.role === 'assistant') assistantMessages.push(message);
      }
    }
    if (assistantMessages.length === 0) return 0;

    let sessionStartMs = assistantMessages[0].timestamp;
    for (const message of assistantMessages) {
      sessionStartMs = Math.min(sessionStartMs, message.timestamp);
    }
    const sessionDurationMs = Math.max(nowMs - sessionStartMs, BURN_RATE_MIN_SESSION_DURATION_MS);
    const recentDurationMs = Math.min(BURN_RATE_RECENT_WINDOW_MS, sessionDurationMs);
    const mediumDurationMs = Math.min(BURN_RATE_MEDIUM_WINDOW_MS, sessionDurationMs);
    const recentCutoffMs = nowMs - recentDurationMs;
    const mediumCutoffMs = nowMs - mediumDurationMs;

    let recentCost = 0;
    let mediumCost = 0;
    let sessionCost = 0;
    for (const message of assistantMessages) {
      const cost = message.usage.cost.total;
      sessionCost += cost;
      if (message.timestamp >= recentCutoffMs) recentCost += cost;
      if (message.timestamp >= mediumCutoffMs) mediumCost += cost;
    }

    const recentRate = (recentCost * MILLISECONDS_PER_HOUR) / recentDurationMs;
    const mediumRate = (mediumCost * MILLISECONDS_PER_HOUR) / mediumDurationMs;
    const sessionRate = (sessionCost * MILLISECONDS_PER_HOUR) / sessionDurationMs;
    const blendedRate =
      recentRate * BURN_RATE_RECENT_WEIGHT +
      mediumRate * BURN_RATE_MEDIUM_WEIGHT +
      sessionRate * BURN_RATE_SESSION_WEIGHT;
    return Math.max(blendedRate, sessionRate);
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
   * Aggregate live token usage and cost by model, optionally including dropped history.
   * Returns results sorted by cost descending.
   */
  getModelCosts(options: CostScopeOptions = {}): ModelCostData[] {
    const modelMap = new Map<string, ModelCostData>();

    // Aggregate live scoops
    const contexts = this.deps.getContexts();
    for (const context of contexts.values()) {
      const messages = context.getAgentMessages();
      const assistantMsgs = messages.filter((m): m is AssistantMessage => m.role === 'assistant');
      this.aggregateMessages(assistantMsgs, modelMap);
    }

    if (options.includeDropped) {
      for (const messages of this.droppedMessages) {
        this.aggregateMessages(messages, modelMap);
      }
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
