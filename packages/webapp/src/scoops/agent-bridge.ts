/**
 * AgentBridge — direct spawn path for the `agent` supplemental shell command.
 *
 * The cone delegates work to scoops via `scoop_scoop` / `feed_scoop` agent
 * tools; the `agent` bash command needs a parallel mechanism available from
 * any shell invocation (cone, scoop, or nested `agent` call). This module
 * implements that mechanism as a thin wrapper over the existing
 * {@link Orchestrator} API:
 *
 *   1. Build a `RegisteredScoop` with a pure-replace `ScoopConfig`
 *      (`visiblePaths` / `writablePaths` / `allowedCommands`) derived from
 *      the `agent` arguments.
 *   2. `orchestrator.registerScoop(scoop)` — awaits `createScoopTab`
 *      (post-#441), so init races with the immediate `sendPrompt` are
 *      impossible.
 *   3. `orchestrator.observeScoop(jid, …)` — subscribes to send_message,
 *      response, status, and error events for this one jid before the
 *      prompt runs so nothing is dropped on the floor.
 *   4. `orchestrator.sendPrompt(jid, prompt, …)` — runs the agent loop to
 *      completion in the context the orchestrator already constructed for
 *      this scoop.
 *   5. `finally`: unsubscribe, `orchestrator.unregisterScoop(jid)`, delete
 *      the scratch folder, and drop any session-store entry.
 *
 * The bridge owns no `ScoopContext`, no `RestrictedFS`, no bash-allowlist
 * wrapping, no callback-forwarding helper, and no model-validation ladder
 * — those all live in the orchestrator / `ScoopConfig` / `AlmostBashShell`
 * layers now. Compare against the original #430 implementation (~770 LOC
 * of bridge alone) to see the effect of that consolidation.
 */

import { createLogger } from '../base/logger.js';
import type { SessionStore } from '../core/session.js';
import type { VirtualFS } from '../fs/index.js';
import { normalizePath } from '../fs/path-utils.js';
import {
  resolveModelSelectionForScoop,
  type ScoopModelResolution,
} from '../providers/account-store.js';
// Legal down-edge (`scoops/` → `tools/`) for the JSON Schema shape.
import type { JsonSchemaObject } from '../tools/types.js';
import { defaultChildVisibleRoots, PRIMARY_WORKSPACE } from '../work-unit/descriptor.js';
import { rootsOf } from '../work-unit/policy.js';
import { modelIdFor, modelProviderFor, thinkingFor } from '../work-unit/record.js';
import { serializeAgentSessionArchive } from './agent-session-archive.js';
import type { Orchestrator } from './orchestrator.js';
import {
  CURRENT_SCOOP_CONFIG_VERSION,
  isThinkingLevel,
  type RegisteredScoop,
  THINKING_LEVELS,
  type ThinkingLevel,
} from './types.js';

const log = createLogger('agent-bridge');

/** Arguments accepted by {@link AgentBridge.spawn}. */
export interface AgentSpawnOptions {
  /** Absolute VFS path that becomes a read-write prefix for the spawned scoop. */
  cwd: string;
  /**
   * Optional writable VFS roots. Pure replace semantics for caller-provided
   * roots; bridge-owned scratch and `/tmp/` remain available. When omitted,
   * the historical `[cwd, '/shared/']` roots are used. Invalid non-absolute
   * entries also fall back to those historical defaults.
   */
  writablePaths?: string[];
  /** Bash command allow-list. Omitted / wildcard means "unrestricted." */
  allowedCommands: string[];
  /** Prompt forwarded verbatim to the spawned scoop's agent loop. */
  prompt: string;
  /**
   * Optional model id override. Accepts a bare id, a shorthand alias
   * (`opus`), or the canonical `provider:model` form printed by the `models`
   * command (`openrouter:openai/gpt-5.6-terra-pro`). When omitted, falls back
   * to the parent scoop's `config.modelId` (if any), then to the UI selection
   * resolved by `ScoopContext.init()`.
   */
  modelId?: string;
  /**
   * Optional provider for {@link AgentSpawnOptions.modelId}, for programmatic
   * callers that already know it. Equivalent to passing
   * `` `${modelProviderId}:${modelId}` `` as the model id — it is validated
   * the same way, so an id the provider doesn't offer is still rejected.
   */
  modelProviderId?: string;
  /**
   * JID of the scoop (or cone) whose shell invoked `agent`. When present
   * and found in `orchestrator.getScoops()`, its `config.modelId` is used
   * for model inheritance. Omitted for top-level terminal invocations.
   */
  parentJid?: string;
  /**
   * Optional read-only VFS roots exposed to the spawned scoop
   * (`visiblePaths` in `ScoopConfig`). Pure replace semantics: when
   * provided, this list entirely supplants the owning cone's workspace
   * default (`['/workspace/']` under the primary cone).
   * Pass `[]` for no extra read-only roots (writablePaths remain readable).
   * Each entry should end with a trailing slash; the bridge normalizes
   * missing ones before forwarding to the orchestrator.
   */
  visiblePaths?: string[];
  /**
   * The invoking shell's cwd (`ctx.cwd` in just-bash) at the moment the
   * caller ran `agent`. When `visiblePaths` is NOT provided, the bridge
   * unions this path into the default read-only roots so the spawned
   * scoop can READ the directory it was launched from without also
   * gaining write access there (unless the first positional `cwd`
   * already grants write inside it). Ignored when `visiblePaths` IS
   * provided — `--read-only` opts the caller out of the implicit add
   * since pure-replace otherwise wouldn't actually be pure-replace.
   *
   * Must be an absolute path. Normalized to a trailing-slash prefix.
   */
  invokingCwd?: string;
  /**
   * Optional reasoning / thinking level override (`off | minimal | low |
   * medium | high | xhigh`). When omitted, falls back to the parent
   * scoop's `config.thinkingLevel` (when found in the orchestrator
   * registry), then to `undefined` — which `ScoopContext.init()` resolves
   * to `'off'` via `resolveThinkingLevel`.
   *
   * `xhigh` is forwarded as-is; ScoopContext clamps to `'high'` at
   * Agent-construction time when the resolved model lacks xhigh support.
   *
   * Validation: `spawn()` validates this field on every call and returns
   * an error result for unknown literal values, regardless of caller —
   * `agent-command.ts` (the `--thinking` CLI flag) and `scoop_scoop`
   * already validate at their layer for tighter user feedback, but
   * direct programmatic / extension callers also hit this path.
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * Optional JSON Schema to enforce on the scoop's final output. When set,
   * a `StructuredOutput` tool is injected and the scoop must return its
   * result in the specified schema shape.
   */
  structuredOutputSchema?: JsonSchemaObject;
  /**
   * Announce completion to the cone on the `scoop-notify` lick channel.
   * Defaults to `false`: a one-shot `agent` call is synchronous for its
   * caller, which already has the result, so notifying would duplicate it.
   * Set this when the spawn is detached and nobody is waiting for the
   * return value — a background pass whose report would otherwise be
   * dropped, leaving the cone with no idea it ran.
   */
  notifyOnComplete?: boolean;
  /**
   * Absolute VFS path of a completion receipt the bridge writes (ISO
   * timestamp content) immediately after the spawned scoop finishes with
   * exit 0, BEFORE the spawn promise resolves. Written with the bridge's
   * full shared-VFS handle — the scoop itself never sees the path. Gives
   * detached callers a durable, per-spawn completion signal in the worker
   * realm for crash-safe bookkeeping (#1989: the curator receipt the boot
   * catch-up checks before trusting a surviving `memoryPending` marker).
   * Best-effort: a receipt write failure is logged, never fails the spawn.
   */
  successReceiptPath?: string;
  /**
   * Persist the spawned agent's full session transcript to disk when the run
   * completes — written on BOTH success and failure, BEFORE the scoop's IDB
   * session is dropped, with the bridge's full shared-VFS handle (the scoop
   * itself never sees the path). For later human analysis; it never touches
   * `/sessions/index.json`. Tri-value:
   *   - `true`      → durable archive at `/sessions/agent-<name>-<timestamp>.md`
   *   - `undefined` → ephemeral archive at `/tmp/agent-<name>-<timestamp>.md`
   *                   (default; `/tmp` is cleared on a new chat)
   *   - `false`     → no archive is written at all
   * `<name>` is the agent name token; `<timestamp>` is
   * `new Date().toISOString()` with `:` and `.` replaced by `-`.
   * Best-effort: a write failure is logged, never fails the spawn.
   */
  persistSession?: boolean;
  /**
   * Fixed agent name token, used instead of the random `<adjective>-<flavor>`
   * generator when provided. Must match the generated name shape — one or more
   * lowercase tokens joined by single dashes, e.g. `memory-curator` — so the
   * `agent-<name>` scratch folder and `agent_<name_with_underscores>` jid both
   * parse cleanly. Validated in `validateSpawnOptions`; a malformed value
   * returns a spawn error instead of registering a scoop.
   */
  name?: string;
  /**
   * Hard turn ceiling for the spawned run (#1972). Enforced in
   * `ScoopContext` where the agent loop runs — the run stops at the
   * bound and the spawn resolves with a non-zero exit carrying the
   * bound note. Unset → unbounded. Must be a positive integer.
   */
  maxTurns?: number;
  /**
   * Hard wall-clock ceiling in ms — same semantics. This is what makes
   * a caller's "timeout" real: resolving a wait early never stopped the
   * run before (one abandoned curator billed $53.81 over 29 minutes
   * against a 120 s timeout).
   */
  maxWallClockMs?: number;
  /**
   * Seconds the spawned scoop's `bash` tool waits for a command before
   * detaching it and continuing the turn (its `background_after` default; a
   * per-call tool argument still wins). Unset → the tool's ten-minute default.
   * Worth tightening for a spawn nobody supervises: the detached command's
   * result comes back as a `bash` lick to the scoop, so the run keeps moving
   * instead of burning its wall-clock ceiling on one wedged command. Must be a
   * number of seconds >= 0 (`0` detaches immediately).
   */
  backgroundAfterSeconds?: number;
  /**
   * Caller-held cancel handle. Aborting stops the running scoop (via
   * `orchestrator.stopScoop`) and resolves the spawn with a non-zero
   * exit; an already-aborted signal short-circuits before any scoop is
   * registered.
   *
   * In-realm only as a live object. Across the panel↔worker transport an
   * `AbortSignal` can't be cloned, so `OffscreenClient.spawnAgent` strips
   * it and forwards cancellation as a wire-safe `agent-spawn-abort`
   * message; the kernel reconstructs an equivalent signal here (#1972).
   */
  signal?: AbortSignal;
}

/** Result returned by {@link AgentBridge.spawn}. */
export interface AgentSpawnResult {
  /**
   * The scoop's final output. Priority:
   *   1. Last `send_message(text)` call the scoop made.
   *   2. Accumulated assistant response text if no send_message fired.
   *   3. Empty string when the scoop produced nothing.
   * On error (`exitCode !== 0`) this is the error message.
   */
  finalText: string;
  /** 0 on success; 1 on any failure (init error, agent error, abort). */
  exitCode: number;
}

/** Public contract exposed on `globalThis.__slicc_agent`. */
export interface AgentBridge {
  spawn(options: AgentSpawnOptions): Promise<AgentSpawnResult>;
}

/** Testability seams. Production defaults are used when unset. */
export interface AgentBridgeDeps {
  /**
   * Override the name generator (for deterministic tests). Returns a
   * single token like `exuberant-lavender` — the bridge then derives the
   * folder (`agent-<name>`) and jid (`agent_<name_with_underscores>`).
   * Default picks a random `<adjective>-<flavor>` pair from the built-in
   * pools.
   */
  generateName?: () => string;
  /**
   * Override the fallback uid generator (hex). Only used when the name
   * generator produces repeated collisions against the orchestrator's
   * existing jids. Kept as a deterministic seam for tests that want to
   * force the fallback path.
   */
  generateUid?: () => string;
  /**
   * Validate a model id and pin it to the provider that serves it. Default
   * looks up via each CONFIGURED provider's full `getProviderModels()` list
   * (NOT the picker-filtered `getAllAvailableModels()`).
   */
  resolveModel?: (modelId: string) => ScoopModelResolution;
}

/** Global hook name used by {@link publishAgentBridge}. */
export const AGENT_BRIDGE_GLOBAL_KEY = '__slicc_agent';

/**
 * The one property this module adds to `globalThis`. Named so the publish path
 * does not cast the global object to an untyped bag; the `agent` command reads
 * the same slot through its own mirror of this declaration (it sits below
 * `scoops/` in the layer stack and cannot import from here).
 */
type AgentBridgeGlobal = typeof globalThis & {
  [AGENT_BRIDGE_GLOBAL_KEY]?: AgentBridge;
};

/** Context for bridge spawn helpers - closed over by the factory. */
interface BridgeContext {
  orchestrator: Orchestrator;
  sharedFs: VirtualFS;
  sessionStore: SessionStore | null | undefined;
  generateName: () => string;
  generateUid: () => string;
  resolveModel: (modelId: string) => ScoopModelResolution;
}

/**
 * Pick a fresh `<adjective>-<flavor>` that doesn't collide with any
 * currently-registered scoop jid. Falls back to hex uid after 8 tries.
 */
function pickFreshNameToken(ctx: BridgeContext): string {
  const MAX_TRIES = 8;
  for (let i = 0; i < MAX_TRIES; i++) {
    const candidate = ctx.generateName();
    const candidateJid = `agent_${tokenToJid(candidate)}`;
    if (!ctx.orchestrator.getScoops().some((s) => s.jid === candidateJid)) {
      return candidate;
    }
  }
  return ctx.generateUid();
}

/**
 * Look up the parent scoop's model AND its pinned provider from the
 * orchestrator registry. Both travel together: inheriting the id without the
 * provider would re-resolve a cross-provider model against the selected
 * provider in the child (#2195).
 */
function resolveParentModelSelection(
  orchestrator: Orchestrator,
  parentJid: string | undefined
): { modelId: string; providerId?: string } | null {
  if (parentJid === undefined) return null;
  const parent = orchestrator.getScoops().find((s) => s.jid === parentJid);
  if (!parent) return null;
  const modelId = modelIdFor(parent);
  if (!modelId || modelId.length === 0) return null;
  const providerId = modelProviderFor(parent);
  return providerId ? { modelId, providerId } : { modelId };
}

/**
 * Default read-only roots for a spawned agent: the workspace of the ROOT that
 * owns the invoking unit (plus the shared skills library when it lives
 * elsewhere), so an agent spawned inside an extra cone — or by one of its
 * scoops — reads that cone's files instead of the primary's (#2271).
 *
 * The ownership walk is `WorkUnitManager.rootOf` — cycle-safe and the same
 * walk the kernel and the completion router use — with the manager's own
 * default-root fallback for a parent that is unknown (a top-level terminal
 * invocation) or whose chain is dangling, so a child's `/scoops/<folder>`
 * can never be handed out as a workspace.
 */
function resolveOwnerVisibleRoots(orchestrator: Orchestrator, parentJid: string | null): string[] {
  const units = orchestrator.getWorkUnits();
  const owner = (parentJid === null ? null : units.rootOf(parentJid)) ?? units.resolveDefaultRoot();
  return defaultChildVisibleRoots(owner?.descriptor.workspace ?? PRIMARY_WORKSPACE);
}

/**
 * Look up the parent scoop's thinkingLevel from the orchestrator registry.
 */
function resolveParentThinkingLevel(
  orchestrator: Orchestrator,
  parentJid: string | undefined
): ThinkingLevel | null {
  if (parentJid === undefined) return null;
  const parent = orchestrator.getScoops().find((s) => s.jid === parentJid);
  if (!parent) return null;
  const level = thinkingFor(parent).level;
  return level && isThinkingLevel(level) ? level : null;
}

/**
 * Validate and resolve model/thinking options. On success returns
 * `{ resolvedModelId, resolvedProviderId }` (the canonical model id after
 * shorthand / `provider:model` expansion, plus the provider it is pinned to);
 * on failure returns `{ error }`.
 */
function validateSpawnOptions(
  options: AgentSpawnOptions,
  resolveModel: (modelId: string) => ScoopModelResolution
):
  | { error: AgentSpawnResult }
  | { resolvedModelId: string | undefined; resolvedProviderId: string | undefined } {
  const requestedModelId = options.modelId;
  let resolvedModelId: string | undefined;
  let resolvedProviderId: string | undefined;
  if (requestedModelId !== undefined) {
    // A separately-supplied provider is folded into the canonical
    // `provider:model` form so both spellings take the identical path.
    const qualified =
      options.modelProviderId !== undefined && requestedModelId !== ''
        ? `${options.modelProviderId}:${requestedModelId}`
        : requestedModelId;
    const resolved: ScoopModelResolution =
      qualified === ''
        ? { ok: false, error: `unknown model: ${requestedModelId}` }
        : resolveModel(qualified);
    if (!resolved.ok) {
      return {
        error: {
          finalText: `agent: ${resolved.error}`,
          exitCode: 1,
        },
      };
    }
    resolvedModelId = resolved.selection.modelId;
    resolvedProviderId = resolved.selection.providerId;
  }

  const requestedLevel = options.thinkingLevel;
  if (requestedLevel !== undefined && !isThinkingLevel(requestedLevel)) {
    return {
      error: {
        finalText: `agent: invalid thinking level: ${String(requestedLevel)} (one of: ${THINKING_LEVELS.join(', ')})`,
        exitCode: 1,
      },
    };
  }

  const backgroundAfter = options.backgroundAfterSeconds;
  if (
    backgroundAfter !== undefined &&
    (typeof backgroundAfter !== 'number' ||
      !Number.isFinite(backgroundAfter) ||
      backgroundAfter < 0)
  ) {
    return {
      error: {
        finalText: `agent: invalid backgroundAfterSeconds: ${String(backgroundAfter)} (seconds >= 0)`,
        exitCode: 1,
      },
    };
  }

  const receiptPath = options.successReceiptPath;
  if (receiptPath !== undefined && !receiptPath.startsWith('/')) {
    return {
      error: {
        finalText: `agent: successReceiptPath must be absolute: ${receiptPath}`,
        exitCode: 1,
      },
    };
  }

  const requestedName = options.name;
  if (requestedName !== undefined && !isValidAgentName(requestedName)) {
    return {
      error: {
        finalText: `agent: invalid name: ${requestedName} (lowercase tokens joined by single dashes)`,
        exitCode: 1,
      },
    };
  }

  for (const [name, value] of [
    ['maxTurns', options.maxTurns],
    ['maxWallClockMs', options.maxWallClockMs],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      return {
        error: {
          finalText: `agent: ${name} must be a positive integer: ${String(value)}`,
          exitCode: 1,
        },
      };
    }
  }

  return { resolvedModelId, resolvedProviderId };
}

/**
 * Write the caller's completion receipt (see
 * {@link AgentSpawnOptions.successReceiptPath}). Best-effort — a failure
 * is logged and the successful spawn result stands.
 */
async function writeSuccessReceipt(sharedFs: VirtualFS, path: string): Promise<void> {
  try {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) await sharedFs.mkdir(dir, { recursive: true });
    await sharedFs.writeFile(path, new Date().toISOString());
  } catch (err) {
    log.warn('success receipt write failed', { path, error: errText(err) });
  }
}

/** A valid fixed agent name: one or more lowercase tokens joined by dashes. */
// Digits are allowed inside a token because a per-cone curator name carries
// the cone's storage folder (`memory-curator-cone-beta-2`, `…-cone-v86`), and
// `coneFolderFor` mints digits both from the user's name and from its own
// de-duplication suffix (#2271). A leading letter is still required so the
// `agent_<token>` jid never starts with a digit.
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
function isValidAgentName(name: string): boolean {
  return AGENT_NAME_PATTERN.test(name);
}

/**
 * `finalText` prefix a fixed-name spawn returns when the name's JID is already
 * registered. Distinct from a run that spawned and failed: the scoop never
 * started and a DIFFERENT one still holds the name — so callers that would fall
 * back to a mutation (e.g. the memory curator's legacy append) must instead
 * defer, or the running namesake will clobber it. See `agentic-memory.ts`.
 */
export const AGENT_NAME_IN_USE_PREFIX = 'agent: name already in use';

/**
 * Persist the spawned agent's transcript to disk (see
 * {@link AgentSpawnOptions.persistSession}). Called from the spawn `finally`,
 * so it runs on BOTH success and failure and BEFORE `cleanupScoop` deletes
 * the IDB session and the `ScoopContext` the history is read from. Uses the
 * bridge's own shared-VFS handle. Best-effort — a failure is logged, never
 * fails the spawn.
 */
async function writeAgentSessionArchive(
  ctx: BridgeContext,
  options: AgentSpawnOptions,
  jid: string,
  nameToken: string,
  outcome: AgentSpawnResult
): Promise<void> {
  if (options.persistSession === false) return;
  const dir = options.persistSession === true ? '/sessions' : '/tmp';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${dir}/agent-${nameToken}-${timestamp}.md`;
  try {
    // The ScoopContext may already be gone (e.g. registerScoop threw); guard.
    const scoopCtx = ctx.orchestrator.getScoopContext(jid);
    const messages =
      typeof scoopCtx?.getAgentMessages === 'function' ? scoopCtx.getAgentMessages() : [];
    const markdown = serializeAgentSessionArchive({
      name: nameToken,
      jid,
      prompt: options.prompt,
      exitCode: outcome.exitCode,
      messages,
      timestamp,
    });
    await ctx.sharedFs.mkdir(dir, { recursive: true });
    await ctx.sharedFs.writeFile(path, markdown);
  } catch (err) {
    log.warn('agent session archive write failed', { path, error: errText(err) });
  }
}

/**
 * Build the scoop config from spawn options and resolved settings.
 */
function buildScoopConfig(
  options: AgentSpawnOptions,
  effectiveModelId: string,
  effectiveModelProviderId: string | undefined,
  effectiveThinkingLevel: ThinkingLevel | undefined,
  scratchFolder: string,
  defaultVisibleRoots: string[]
): NonNullable<RegisteredScoop['config']> {
  const cwdPrefix = normalizeRwPrefix(options.cwd);
  const visiblePaths = resolveVisiblePaths(options, defaultVisibleRoots);
  const configuredWritable = resolveWritablePaths(options.writablePaths, cwdPrefix);
  const writablePaths = dedupePrefixes([...configuredWritable, `${scratchFolder}/`, '/tmp/']);

  const scoopConfig: NonNullable<RegisteredScoop['config']> = {
    visiblePaths,
    writablePaths,
    allowedCommands: options.allowedCommands,
  };
  if (options.maxTurns !== undefined) {
    scoopConfig.maxTurns = options.maxTurns;
  }
  if (options.maxWallClockMs !== undefined) {
    scoopConfig.maxWallClockMs = options.maxWallClockMs;
  }
  if (options.backgroundAfterSeconds !== undefined) {
    scoopConfig.backgroundAfterSeconds = options.backgroundAfterSeconds;
  }
  if (effectiveModelId) {
    scoopConfig.modelId = effectiveModelId;
    if (effectiveModelProviderId !== undefined) {
      scoopConfig.modelProviderId = effectiveModelProviderId;
    }
  }
  if (effectiveThinkingLevel !== undefined) {
    scoopConfig.thinkingLevel = effectiveThinkingLevel;
  }
  if (options.structuredOutputSchema !== undefined) {
    scoopConfig.structuredOutputSchema = options.structuredOutputSchema;
  }

  return scoopConfig;
}

/**
 * Register observer callbacks to capture scoop events.
 * Returns state object (mutated by callbacks) plus unsubscribe function.
 */
function registerScoopObserver(orchestrator: Orchestrator, jid: string) {
  const state = {
    sendMessages: [] as string[],
    responseBuffer: '',
    scoopError: null as string | null,
    unsubscribe: null as (() => void) | null,
  };

  state.unsubscribe = orchestrator.observeScoop(jid, {
    onSendMessage: (text) => {
      state.sendMessages.push(text);
    },
    onResponse: (text, isPartial) => {
      if (isPartial) {
        state.responseBuffer += text;
      } else {
        state.responseBuffer = text;
      }
    },
    onError: (errMsg) => {
      if (state.scoopError === null) {
        state.scoopError = errMsg;
      }
    },
  });

  return state;
}

/**
 * Prompt scoop and optionally nudge for structured output.
 */
async function runScoopAndCaptureOutput(
  orchestrator: Orchestrator,
  jid: string,
  prompt: string,
  structuredOutputSchema: JsonSchemaObject | undefined,
  observerState: ReturnType<typeof registerScoopObserver>
): Promise<AgentSpawnResult | null> {
  await orchestrator.sendPrompt(jid, prompt, 'agent', 'agent');

  if (observerState.scoopError !== null) {
    return { finalText: observerState.scoopError, exitCode: 1 };
  }

  if (structuredOutputSchema) {
    const ctxRef = orchestrator.getScoopContext(jid);
    let so = ctxRef?.getStructuredOutput?.();
    for (let nudge = 0; nudge < 2 && !so?.captured; nudge++) {
      await orchestrator.sendPrompt(
        jid,
        'You did not call StructuredOutput. Call it now with your result, matching the schema.',
        'agent',
        'agent'
      );
      // Each nudge is its own LLM round-trip: surface a real error (rate limit,
      // 5xx, capability shim) instead of masking it as "did not produce output".
      if (observerState.scoopError !== null) {
        return { finalText: observerState.scoopError, exitCode: 1 };
      }
      so = ctxRef?.getStructuredOutput?.();
    }
    if (so?.captured) {
      return { finalText: JSON.stringify(so.value), exitCode: 0 };
    }
    return { finalText: 'agent: scoop did not produce StructuredOutput', exitCode: 1 };
  }

  const finalText =
    observerState.sendMessages.length > 0
      ? observerState.sendMessages[observerState.sendMessages.length - 1]
      : observerState.responseBuffer;
  return { finalText, exitCode: 0 };
}

/**
 * Best-effort cleanup: unregister scoop, remove scratch folder, delete session.
 */
async function cleanupScoop(
  ctx: BridgeContext,
  jid: string,
  folder: string,
  scratchFolder: string
): Promise<void> {
  try {
    await ctx.orchestrator.unregisterScoop(jid);
  } catch (err) {
    log.warn('unregisterScoop failed', { jid, error: errText(err) });
  }
  try {
    await ctx.sharedFs.rm(scratchFolder, { recursive: true });
  } catch (err) {
    if (!isFsErrorCode(err, 'ENOENT')) {
      log.warn('scratch folder cleanup failed', { folder, error: errText(err) });
    }
  }
  if (ctx.sessionStore) {
    try {
      await ctx.sessionStore.delete(jid);
    } catch (err) {
      log.warn('sessionStore.delete failed', { jid, error: errText(err) });
    }
  }
}

/**
 * Register the scoop, run its agent loop, and map the run to an
 * {@link AgentSpawnResult} — never throwing (every failure path returns an
 * exit-1 result). Extracted from `spawn` so the caller can keep the
 * archive-then-cleanup `finally` thin. A `registerScoop` failure still
 * returns a value here, so `spawn`'s `finally` runs cleanup regardless.
 */
async function runScoopToOutcome(
  ctx: BridgeContext,
  options: AgentSpawnOptions,
  scoop: RegisteredScoop,
  jid: string,
  observerHandle: ReturnType<typeof registerScoopObserver>
): Promise<AgentSpawnResult> {
  try {
    await ctx.orchestrator.registerScoop(scoop);
  } catch (err) {
    return { finalText: observerHandle.scoopError ?? errText(err), exitCode: 1 };
  }

  try {
    const result = await runScoopAndCaptureOutput(
      ctx.orchestrator,
      jid,
      options.prompt,
      options.structuredOutputSchema,
      observerHandle
    );
    if (options.signal?.aborted) {
      return { finalText: 'agent: aborted', exitCode: 1 };
    }
    if (result) {
      // Durable completion signal, written before the spawn resolves so
      // it lands strictly earlier than any caller-side bookkeeping.
      if (result.exitCode === 0 && options.successReceiptPath) {
        await writeSuccessReceipt(ctx.sharedFs, options.successReceiptPath);
      }
      return result;
    }
    return { finalText: observerHandle.scoopError ?? '', exitCode: 1 };
  } catch (err) {
    return { finalText: observerHandle.scoopError ?? errText(err), exitCode: 1 };
  }
}

/**
 * Create an {@link AgentBridge} bound to an orchestrator + shared VFS.
 *
 * `sharedFs` is used only for the scratch-folder cleanup
 * (`/scoops/agent-<adjective>-<flavor>/`); the orchestrator builds the
 * scoop's `RestrictedFS` itself from `scoop.config`.
 */
export function createAgentBridge(
  orchestrator: Orchestrator,
  sharedFs: VirtualFS,
  sessionStore: SessionStore | null | undefined = null,
  deps: AgentBridgeDeps = {}
): AgentBridge {
  const ctx: BridgeContext = {
    orchestrator,
    sharedFs,
    sessionStore,
    generateName: deps.generateName ?? defaultGenerateName,
    generateUid: deps.generateUid ?? defaultGenerateUid,
    resolveModel: deps.resolveModel ?? defaultResolveModel,
  };

  async function spawn(options: AgentSpawnOptions): Promise<AgentSpawnResult> {
    const validation = validateSpawnOptions(options, ctx.resolveModel);
    if ('error' in validation) return validation.error;

    const parentModel = resolveParentModelSelection(ctx.orchestrator, options.parentJid);
    const effectiveModelId = validation.resolvedModelId ?? parentModel?.modelId ?? '';
    const effectiveModelProviderId =
      validation.resolvedModelId !== undefined
        ? validation.resolvedProviderId
        : parentModel?.providerId;

    const requestedLevel = options.thinkingLevel;
    const effectiveThinkingLevel =
      requestedLevel ??
      resolveParentThinkingLevel(ctx.orchestrator, options.parentJid) ??
      undefined;

    // A validated fixed name wins; otherwise pick a fresh collision-free token.
    const nameToken = options.name !== undefined ? options.name : pickFreshNameToken(ctx);
    const folder = `agent-${nameToken}`;
    const jid = `agent_${tokenToJid(nameToken)}`;
    // A fixed name bypasses pickFreshNameToken's collision guard: if a scoop
    // with this JID is still registered — a detached run still in flight, or a
    // crashed one not yet cleaned up — reusing the name would clobber its
    // session history and scratch folder. Reject rather than collide; the
    // random path can never hit this (it excludes live JIDs by construction).
    if (options.name !== undefined && ctx.orchestrator.getScoops().some((s) => s.jid === jid)) {
      return { finalText: `${AGENT_NAME_IN_USE_PREFIX}: ${nameToken}`, exitCode: 1 };
    }
    const scratchFolder = `/scoops/${folder}`;

    // Ownership edge: the invoking unit when the caller supplied it,
    // otherwise the default root — a spawned agent always has an owner.
    // (`originToolCallId` stays never-inferred; this is ownership, not
    // tool-call provenance.)
    const parentJid = options.parentJid ?? rootsOf(ctx.orchestrator.getScoops())[0]?.jid ?? null;
    const scoopConfig = buildScoopConfig(
      options,
      effectiveModelId,
      effectiveModelProviderId,
      effectiveThinkingLevel,
      scratchFolder,
      resolveOwnerVisibleRoots(ctx.orchestrator, parentJid)
    );

    const scoop: RegisteredScoop = {
      jid,
      name: folder,
      folder,
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: folder,
      addedAt: new Date().toISOString(),
      config: scoopConfig,
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
      notifyOnComplete: options.notifyOnComplete === true,
      parentJid,
    };

    const observerHandle = registerScoopObserver(ctx.orchestrator, jid);
    // Caller-held cancel: stop the running scoop so an abandoned wait
    // actually reclaims the run instead of letting it keep billing.
    const onAbort = (): void => {
      try {
        ctx.orchestrator.stopScoop(jid);
      } catch (err) {
        log.warn('stopScoop on abort failed', { jid, error: errText(err) });
      }
    };
    // Attach BEFORE the aborted-check, then re-check: an abort landing in
    // the window between check and attach would otherwise be missed
    // (AbortSignal fires exactly once), leaving stopScoop uncalled and the
    // cancellation deferred to the post-run gate — the 30s+ window this is
    // meant to eliminate.
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      options.signal.removeEventListener('abort', onAbort);
      observerHandle.unsubscribe?.();
      return { finalText: 'agent: aborted before start', exitCode: 1 };
    }

    // Held so the `finally` can archive the transcript with the real exit
    // code, whatever path `runScoopToOutcome` leaves through.
    let outcome: AgentSpawnResult = { finalText: '', exitCode: 1 };
    try {
      outcome = await runScoopToOutcome(ctx, options, scoop, jid, observerHandle);
      return outcome;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      observerHandle.unsubscribe?.();
      // Archive the transcript BEFORE cleanupScoop drops the IDB session and
      // the ScoopContext the history is read from. Runs on success AND failure.
      await writeAgentSessionArchive(ctx, options, jid, nameToken, outcome);
      await cleanupScoop(ctx, jid, folder, scratchFolder);
    }
  }

  return { spawn };
}

/**
 * Bootstrap helper for the CLI / webapp realm. Publishes the bridge on
 * `globalThis.__slicc_agent` so the `agent` supplemental command can find
 * it. Throws synchronously if the orchestrator isn't initialized yet —
 * callers MUST NOT publish a half-initialized hook.
 */
export function publishAgentBridge(
  orchestrator: Orchestrator,
  sharedFs: VirtualFS,
  sessionStore: SessionStore | null | undefined = null,
  deps: AgentBridgeDeps = {}
): AgentBridge {
  const bridge = createAgentBridge(orchestrator, sharedFs, sessionStore, deps);
  (globalThis as AgentBridgeGlobal)[AGENT_BRIDGE_GLOBAL_KEY] = bridge;
  log.info('agent bridge published on globalThis.__slicc_agent');
  return bridge;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function defaultGenerateUid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === 'function') {
    return g.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Playful adjectives. Keep this list single-word and all-lowercase — the
 * bridge joins with a dash (folder) or underscore (jid), so anything
 * weirder than `[a-z]+` would break the naming predicate assumed by
 * callers (tests regex on `/^agent-[a-z]+-[a-z]+$/`).
 */
const AGENT_ADJECTIVES: readonly string[] = [
  'amber',
  'bouncy',
  'breezy',
  'bubbly',
  'cheeky',
  'chilly',
  'cozy',
  'dapper',
  'dreamy',
  'eager',
  'exuberant',
  'fluffy',
  'frosty',
  'gentle',
  'giddy',
  'glossy',
  'jolly',
  'lucky',
  'mellow',
  'merry',
  'nimble',
  'plucky',
  'quirky',
  'salty',
  'sleepy',
  'snappy',
  'sparkly',
  'spiffy',
  'sunny',
  'sweet',
  'toasty',
  'velvety',
  'whimsy',
  'zesty',
];

/**
 * Ice-cream flavors. Single-word only (see {@link AGENT_ADJECTIVES}); a
 * multi-word flavor like `rocky-road` would produce
 * `agent-adjective-rocky-road` which breaks the two-token regex.
 */
const AGENT_FLAVORS: readonly string[] = [
  'blueberry',
  'butterscotch',
  'caramel',
  'cherry',
  'chocolate',
  'cinnamon',
  'coconut',
  'coffee',
  'cookies',
  'custard',
  'espresso',
  'fudge',
  'gelato',
  'hazelnut',
  'honeycomb',
  'lavender',
  'lemon',
  'mango',
  'maple',
  'marzipan',
  'matcha',
  'mint',
  'mocha',
  'neapolitan',
  'nougat',
  'peach',
  'pecan',
  'pistachio',
  'praline',
  'raspberry',
  'sherbet',
  'sorbet',
  'stracciatella',
  'strawberry',
  'tiramisu',
  'toffee',
  'vanilla',
];

/**
 * Pick a random `<adjective>-<flavor>` pair. Adjective × flavor gives
 * hundreds of combinations (currently 34 × 37 = 1258), so collisions
 * inside a single run are vanishingly unlikely — but the bridge still
 * retries up to eight times and falls back to a hex uid just in case.
 */
function defaultGenerateName(): string {
  const adjective = AGENT_ADJECTIVES[Math.floor(Math.random() * AGENT_ADJECTIVES.length)];
  const flavor = AGENT_FLAVORS[Math.floor(Math.random() * AGENT_FLAVORS.length)];
  return `${adjective}-${flavor}`;
}

/**
 * Convert a name token to its jid-compatible form. Folders use dashes
 * (`agent-exuberant-lavender`) and jids use underscores
 * (`agent_exuberant_lavender`). Hex-uid fallback tokens pass through
 * unchanged because they contain neither.
 */
function tokenToJid(token: string): string {
  return token.replace(/-/g, '_');
}

/**
 * Default model resolver. Returns the canonical id the spawned scoop will
 * actually run as PLUS the provider it is pinned to, or a failure reason.
 *
 * Delegates to `resolveModelSelectionForScoop()`, which validates every
 * candidate (the id verbatim, its `provider:model` split, then its shorthand
 * expansion) through the SAME `resolveModelById()` the spawn path uses. Validating against a looser
 * notion of "known" — e.g. any account's `getProviderModels()` list — let a
 * bare alias like `claude-haiku-4-5` pass while the scoop silently ran as the
 * cone's model. The picker filter (`PICKER_HIDDEN_MODEL_PATTERNS`, e.g.
 * `/haiku/i`) is deliberately NOT consulted: a picker-hidden model is still a
 * legitimate explicit sub-agent target (the very "haiku scoop for cheap
 * throwaway work" the picker hides it to avoid as a *cone* default).
 *
 * Tests can replace this via `deps.resolveModel` without touching
 * provider-settings state.
 */
export function defaultResolveModel(modelId: string): ScoopModelResolution {
  try {
    return resolveModelSelectionForScoop(modelId);
  } catch (err) {
    // getAccounts/getProviderModels normally return [] (and self-log) on a provider/parse
    // failure; the only throws that reach here are residual storage/environment faults
    // (e.g. a SecurityError, or a missing storage shim). Without a breadcrumb the caller
    // gets a misleading "unknown model: <id>" for what is really an environment fault.
    log.warn('defaultResolveModel: provider/account lookup threw; treating model as unknown', {
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: `unknown model: ${modelId}` };
  }
}

function normalizeRwPrefix(path: string): string {
  const normalized = normalizePath(path);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function resolveWritablePaths(paths: string[] | undefined, cwdPrefix: string): string[] {
  const defaults = [cwdPrefix, '/shared/'];
  if (paths === undefined) return defaults;
  if (
    paths.some((path) => typeof path !== 'string' || !path.startsWith('/') || path.includes('\0'))
  ) {
    return defaults;
  }
  return paths.map(normalizeRwPrefix);
}

/**
 * Compute the visiblePaths list from spawn options.
 *
 * - `--read-only` set (any value, including `[]`): pure replace. The
 *   caller explicitly opted out of BOTH the owning cone's workspace AND
 *   the implicit `invokingCwd` add — we don't fight that.
 * - `--read-only` absent: return `defaultVisibleRoots` — the workspace of the
 *   root that owns the spawning unit plus the shared skills library
 *   (`['/workspace/']` for the primary cone, #2271) — unioned with
 *   the invoking shell's `ctx.cwd` (when provided), so agents launched
 *   from anywhere on the VFS can still READ the directory they were
 *   spawned from. De-duped on the normalized trailing-slash form.
 */
function resolveVisiblePaths(options: AgentSpawnOptions, defaultVisibleRoots: string[]): string[] {
  if (options.visiblePaths !== undefined) {
    return options.visiblePaths.map(normalizeRwPrefix);
  }
  const base = [...defaultVisibleRoots];
  if (options.invokingCwd && options.invokingCwd.length > 0) {
    base.push(normalizeRwPrefix(options.invokingCwd));
  }
  return dedupePrefixes(base);
}

/**
 * De-duplicate a list of VFS prefixes, preserving first-seen order.
 * Compares strings verbatim — callers must have already normalized each
 * entry to the trailing-slash form (see {@link normalizeRwPrefix}) so
 * `/foo` and `/foo/` don't survive as separate entries.
 */
function dedupePrefixes(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  }
  return result;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Narrow test: is this an FsError (or any error-like object) whose POSIX
 * error code matches `expected`? `FsError` exposes `.code` directly; for
 * future cross-package interop we also accept any object with a `code`
 * property (some runtimes wrap FsError into a plain value before it
 * propagates). Non-string codes are rejected so a numeric errno from
 * Node won't accidentally match.
 */
function isFsErrorCode(err: unknown, expected: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === expected;
}
