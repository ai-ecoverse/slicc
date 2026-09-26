/**
 * Per-session cost tracking for the `cost` shell command.
 *
 * Aggregates per-scoop usage from each context's assistant messages and
 * preserves costs for scoops that have been dropped within the current
 * session so the cone can still see the total spend (PR #1091 extracted this
 * out of Orchestrator to keep that class focused on lifecycle).
 *
 * Silent one-shot children (`notifyOnComplete === false`, e.g. the `agent`
 * shell command) are different: they are unregistered as soon as they finish,
 * so a bare `cost --json` (live scope) would never see them. On snapshot the
 * tracker folds their assistant-message usage into the still-live parent
 * instead of a separate dropped row (#3437). The parent's `models` list then
 * includes the child's model, and `--all` does not double-count while the
 * parent is live.
 *
 * A New-session clear of that parent must not keep the fold on the fresh
 * cone: {@link settleFolded} clears the live bucket and either merges the
 * spend into the cone's newest frozen index row (when the freezer just wrote
 * one) or retains it on the dropped ledger, so `cost --all` still sees it.
 *
 * The tracker is intentionally read-mostly — it doesn't subscribe to scoop
 * events. The orchestrator calls {@link snapshot} once on unregister, and the
 * `cost` shell command reads {@link getSessionCosts} on demand.
 */

import type { AssistantMessage } from '../core/types.js';
import { canonicalModelId, representativeModelId } from '../providers/claude-model-version.js';
import type { ScoopCostData } from '../shell/supplemental-commands/cost-command.js';
import { isRootUnit } from '../work-unit/policy.js';
import { modelIdFor, modelProviderFor } from '../work-unit/record.js';
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

/** Spellings of one model seen while folding usage, plus that model's cost. */
interface ModelSpellings {
  ids: string[];
  cost: number;
}

function addModelSpelling(
  buckets: Map<string, ModelSpellings>,
  modelId: string,
  cost: number
): void {
  const key = canonicalModelId(modelId);
  const bucket = buckets.get(key);
  if (!bucket) {
    buckets.set(key, { ids: [modelId], cost });
    return;
  }
  if (!bucket.ids.includes(modelId)) bucket.ids.push(modelId);
  bucket.cost += cost;
}

/**
 * Distinct models, most expensive first. `currentRaw` is the id in use now;
 * its entry keeps that spelling so the scalar and the set agree.
 */
function reportModelSpellings(
  buckets: Map<string, ModelSpellings>,
  currentRaw: string
): { current: string; models: string[] } {
  const models = [...buckets.values()]
    .sort((a, b) => b.cost - a.cost || (a.ids[0] ?? '').localeCompare(b.ids[0] ?? ''))
    .map((bucket) => representativeModelId(bucket.ids, currentRaw));
  const currentBucket = buckets.get(canonicalModelId(currentRaw));
  const current = currentBucket ? representativeModelId(currentBucket.ids, currentRaw) : currentRaw;
  return { current, models };
}

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
  /**
   * Optional: merge settled fold spend into the cone's newest frozen index
   * row (the freezer writes it moments before clear). Return true when the
   * spend landed there so the tracker can skip the dropped ledger and
   * `cost --all` does not double-count (#3437 review).
   */
  mergeFoldedIntoFrozen?(
    jid: string,
    folded: readonly AssistantMessage[]
  ): boolean | Promise<boolean>;
}

export interface CostScopeOptions {
  includeDropped?: boolean;
}

/**
 * Build cost data for a single scoop from its context's assistant messages.
 * Returns `null` when the scoop has no usage yet (no assistant turns).
 *
 * `model` is the model in use now — a provider-qualified pin, or the latest
 * assistant turn when the record has no pin. A provider-less legacy pin is
 * used only when it names the same model as that latest turn; otherwise the
 * turn wins, because `resolveModelForInit` may already have fallen off a
 * stale pre-#2195 id. Not the model with the most turns. `models` lists each
 * distinct model once: a bare Claude alias and a Bedrock region- or
 * version-qualified spelling of that same model collapse, and the entry for
 * the model in use now keeps the current spelling. A suffixed variant
 * (`-fast`) stays its own entry.
 *
 * Active time is rounded up to 15-minute intervals so a long-idle scoop with
 * a handful of turns doesn't read as "zero minutes" in the `cost` table.
 */
/**
 * Id to report as "in use now".
 *
 * A provider-qualified pin is the model the unit was told to run, including
 * a switch that has not written a turn yet. A provider-less legacy pin
 * (`config.modelId` with no provider, pre-#2195) may be an id the selected
 * provider no longer serves; init then runs the resolved model, which the
 * latest assistant turn records. When that turn names a different model,
 * the turn is what is actually in use.
 */
function modelInUseNow(scoop: RegisteredScoop, latestModel: string): string {
  const pinned = modelIdFor(scoop);
  if (!pinned) return latestModel;
  if (!modelProviderFor(scoop) && canonicalModelId(latestModel) !== canonicalModelId(pinned)) {
    return latestModel;
  }
  return pinned;
}

export function buildScoopCost(
  scoop: RegisteredScoop,
  context: ScoopContext,
  source: ScoopCostData['source'] = 'live',
  /** Assistant turns folded in from silent child scoops (see {@link ScoopCostTracker.snapshot}). */
  foldedMessages: readonly AssistantMessage[] = []
): ScoopCostData | null {
  const messages = context.getAgentMessages();
  const ownAssistant = messages.filter((m): m is AssistantMessage => m.role === 'assistant');
  const assistantMsgs = [...ownAssistant, ...foldedMessages];
  if (assistantMsgs.length === 0) return null;

  const aggregated = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const buckets = new Map<string, ModelSpellings>();
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
    addModelSpelling(buckets, msg.model, msg.usage.cost.total);
  }

  // Prefer the parent's own latest turn for "in use now"; fall back to folded
  // children only when the parent has never spoken (agent-only spend).
  const latestPool = ownAssistant.length > 0 ? ownAssistant : assistantMsgs;
  const latest = latestPool.reduce((best, msg) => (msg.timestamp >= best.timestamp ? msg : best));
  const currentRaw = modelInUseNow(scoop, latest.model);
  const reported = reportModelSpellings(buckets, currentRaw);

  const timestamps = assistantMsgs.map((m) => m.timestamp).sort((a, b) => a - b);
  const firstActivity = timestamps[0];
  const lastActivity = timestamps[timestamps.length - 1];

  const timespanMs = lastActivity - firstActivity;
  const intervals = Math.max(1, Math.ceil(timespanMs / FIFTEEN_MINUTES_MS));
  const activeTimeMs = intervals * FIFTEEN_MINUTES_MS;

  return {
    name: scoop.assistantLabel,
    type: isRootUnit(scoop) ? 'cone' : 'scoop',
    model: reported.current,
    models: reported.models,
    source,
    usage: aggregated,
    turns: assistantMsgs.length,
    firstActivity,
    lastActivity,
    activeTimeMs,
  };
}

/**
 * Silent one-shot children (`notifyOnComplete === false`) whose parent is still
 * registered fold into that parent on teardown — otherwise their billable
 * usage vanishes from bare `cost --json` (#3437).
 */
function shouldFoldIntoParent(
  scoop: RegisteredScoop,
  scoops: ReadonlyMap<string, RegisteredScoop>
): scoop is RegisteredScoop & { parentJid: string } {
  return (
    scoop.notifyOnComplete === false && scoop.parentJid !== null && scoops.has(scoop.parentJid)
  );
}

export class ScoopCostTracker {
  /** Preserves cost data for scoops that have been dropped this session. */
  private dropped: ScoopCostData[] = [];
  /** Preserves assistant messages for dropped scoops to enable per-model aggregation. */
  private droppedMessages: AssistantMessage[][] = [];
  /**
   * Assistant turns from silent one-shot children, keyed by the still-live
   * parent jid they folded into. Merged into that parent's live (and later
   * dropped) cost row so bare `cost --json` keeps the spend (#3437).
   */
  private foldedByParent = new Map<string, AssistantMessage[]>();
  private readonly deps: ScoopCostTrackerDeps;

  constructor(deps: ScoopCostTrackerDeps) {
    this.deps = deps;
  }

  /** Assistant turns previously folded into `jid` from silent children. */
  private foldedMessagesFor(jid: string): readonly AssistantMessage[] {
    return this.foldedByParent.get(jid) ?? [];
  }

  /**
   * Move silent-child spend attributed to `jid` off the live fold bucket.
   * Prefers merging into the cone's newest frozen index row when
   * {@link ScoopCostTrackerDeps.mergeFoldedIntoFrozen} succeeds; otherwise
   * retains the spend on the dropped ledger so `cost --all` still sees it.
   * Called at the cone session boundary (New chat) (#3437 review).
   */
  async settleFolded(jid: string): Promise<void> {
    const folded = this.foldedByParent.get(jid);
    this.foldedByParent.delete(jid);
    if (!folded || folded.length === 0) return;

    const scoop = this.deps.getScoops().get(jid);
    if (!scoop) return;

    const merged = await this.deps.mergeFoldedIntoFrozen?.(jid, folded);
    if (merged) return;

    // No fresh archive (erase / short-session skip) — keep spend on the
    // dropped ledger so `cost --all` still reports it.
    const emptyContext = { getAgentMessages: () => [] } as unknown as ScoopContext;
    const costData = buildScoopCost(scoop, emptyContext, 'dropped', folded);
    if (!costData) return;
    this.droppedMessages.push([...folded]);
    this.dropped.push(costData);
  }

  /** Snapshot a scoop's cost data before it is destroyed. */
  snapshot(jid: string): void {
    const scoops = this.deps.getScoops();
    const scoop = scoops.get(jid);
    const context = this.deps.getContexts().get(jid);
    if (!scoop || !context) return;

    const messages = context.getAgentMessages();
    const ownAssistant = messages.filter((m): m is AssistantMessage => m.role === 'assistant');
    // A parent may carry folded child spend with no turns of its own.
    const foldedIntoSelf = [...this.foldedMessagesFor(jid)];

    if (shouldFoldIntoParent(scoop, scoops)) {
      if (ownAssistant.length === 0 && foldedIntoSelf.length === 0) return;
      const parentJid = scoop.parentJid;
      const existing = this.foldedByParent.get(parentJid) ?? [];
      this.foldedByParent.set(parentJid, [...existing, ...ownAssistant, ...foldedIntoSelf]);
      // Drop the child's own fold bucket so cascade teardown (child → parent)
      // does not double-count when the parent is snapshotted next.
      this.foldedByParent.delete(jid);
      return;
    }

    const costData = buildScoopCost(scoop, context, 'dropped', foldedIntoSelf);
    if (costData) {
      this.dropped.push(costData);
    }
    const forModelAgg = [...ownAssistant, ...foldedIntoSelf];
    if (forModelAgg.length > 0) {
      this.droppedMessages.push(forModelAgg);
    }
    this.foldedByParent.delete(jid);
  }

  /** Collect cost data from live scoops, optionally including dropped history. */
  getSessionCosts(options: CostScopeOptions = {}): ScoopCostData[] {
    const results: ScoopCostData[] = [];
    const contexts = this.deps.getContexts();
    for (const scoop of this.deps.getScoops().values()) {
      const context = contexts.get(scoop.jid);
      if (!context) continue;
      const costData = buildScoopCost(scoop, context, 'live', this.foldedMessagesFor(scoop.jid));
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
    for (const folded of this.foldedByParent.values()) {
      assistantMessages.push(...folded);
    }
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
    const spellings = new Map<string, ModelSpellings>();

    // Aggregate live scoops (plus silent children folded into them).
    const contexts = this.deps.getContexts();
    for (const [jid, context] of contexts) {
      const messages = context.getAgentMessages();
      const assistantMsgs = messages.filter((m): m is AssistantMessage => m.role === 'assistant');
      this.aggregateMessages(assistantMsgs, modelMap, spellings);
      this.aggregateMessages(this.foldedMessagesFor(jid), modelMap, spellings);
    }

    if (options.includeDropped) {
      for (const messages of this.droppedMessages) {
        this.aggregateMessages(messages, modelMap, spellings);
      }
    }

    for (const [key, bucket] of spellings) {
      const row = modelMap.get(key);
      if (row) row.model = representativeModelId(bucket.ids);
    }

    // Convert to array and sort by cost descending
    return Array.from(modelMap.values()).sort((a, b) => b.cost - a.cost);
  }

  /** Helper to aggregate messages into the model map. */
  private aggregateMessages(
    messages: readonly AssistantMessage[],
    modelMap: Map<string, ModelCostData>,
    spellings: Map<string, ModelSpellings>
  ): void {
    for (const msg of messages) {
      const key = canonicalModelId(msg.model);
      addModelSpelling(spellings, msg.model, msg.usage.cost.total);
      const existing = modelMap.get(key);
      if (existing) {
        existing.input += msg.usage.input;
        existing.output += msg.usage.output;
        existing.cacheRead += msg.usage.cacheRead;
        existing.cacheWrite += msg.usage.cacheWrite;
        existing.cost += msg.usage.cost.total;
        existing.turns += 1;
      } else {
        modelMap.set(key, {
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
    this.foldedByParent.clear();
  }
}
