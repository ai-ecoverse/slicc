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

import { createLogger } from '../core/logger.js';
import type { SessionStore } from '../core/session.js';
import type { VirtualFS } from '../fs/index.js';
import { normalizePath } from '../fs/path-utils.js';
import {
  getAccounts,
  getProviderModels,
  resolveModelByShorthand,
} from '../providers/account-store.js';
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
  /** Bash command allow-list. Omitted / wildcard means "unrestricted." */
  allowedCommands: string[];
  /** Prompt forwarded verbatim to the spawned scoop's agent loop. */
  prompt: string;
  /**
   * Optional model id override. When omitted, falls back to the parent
   * scoop's `config.modelId` (if any), then to the UI selection resolved
   * by `ScoopContext.init()`.
   */
  modelId?: string;
  /**
   * JID of the scoop (or cone) whose shell invoked `agent`. When present
   * and found in `orchestrator.getScoops()`, its `config.modelId` is used
   * for model inheritance. Omitted for top-level terminal invocations.
   */
  parentJid?: string;
  /**
   * Optional read-only VFS roots exposed to the spawned scoop
   * (`visiblePaths` in `ScoopConfig`). Pure replace semantics: when
   * provided, this list entirely supplants the default `['/workspace/']`.
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
  structuredOutputSchema?: Record<string, unknown>;
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
   * Validate a model id. Returns the input on success, null when unknown.
   * Default looks up via each provider's full `getProviderModels()` list
   * (NOT the picker-filtered `getAllAvailableModels()`).
   */
  resolveModel?: (modelId: string) => string | null;
}

/** Global hook name used by {@link publishAgentBridge}. */
export const AGENT_BRIDGE_GLOBAL_KEY = '__slicc_agent';

/** Context for bridge spawn helpers - closed over by the factory. */
interface BridgeContext {
  orchestrator: Orchestrator;
  sharedFs: VirtualFS;
  sessionStore: SessionStore | null | undefined;
  generateName: () => string;
  generateUid: () => string;
  resolveModel: (modelId: string) => string | null;
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
 * Look up the parent scoop's modelId from the orchestrator registry.
 */
function resolveParentModelId(
  orchestrator: Orchestrator,
  parentJid: string | undefined
): string | null {
  if (parentJid === undefined) return null;
  const parent = orchestrator.getScoops().find((s) => s.jid === parentJid);
  if (!parent) return null;
  const modelId = parent.config?.modelId;
  return modelId && modelId.length > 0 ? modelId : null;
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
  const level = parent.config?.thinkingLevel;
  return level && isThinkingLevel(level) ? level : null;
}

/**
 * Validate and resolve model/thinking options. On success returns
 * `{ resolvedModelId }` (the canonical model id after shorthand
 * expansion); on failure returns `{ error }`.
 */
function validateSpawnOptions(
  options: AgentSpawnOptions,
  resolveModel: (modelId: string) => string | null
): { error: AgentSpawnResult } | { resolvedModelId: string | undefined } {
  const requestedModelId = options.modelId;
  let resolvedModelId: string | undefined;
  if (requestedModelId !== undefined) {
    const resolved = requestedModelId === '' ? null : resolveModel(requestedModelId);
    if (resolved === null) {
      return {
        error: {
          finalText: `agent: unknown model: ${requestedModelId}`,
          exitCode: 1,
        },
      };
    }
    resolvedModelId = resolved;
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

  return { resolvedModelId };
}

/**
 * Build the scoop config from spawn options and resolved settings.
 */
function buildScoopConfig(
  options: AgentSpawnOptions,
  effectiveModelId: string,
  effectiveThinkingLevel: ThinkingLevel | undefined,
  scratchFolder: string
): NonNullable<RegisteredScoop['config']> {
  const cwdPrefix = normalizeRwPrefix(options.cwd);
  const visiblePaths = resolveVisiblePaths(options);
  const writablePaths = dedupePrefixes([cwdPrefix, '/shared/', `${scratchFolder}/`, '/tmp/']);

  const scoopConfig: NonNullable<RegisteredScoop['config']> = {
    visiblePaths,
    writablePaths,
    allowedCommands: options.allowedCommands,
  };
  if (effectiveModelId) {
    scoopConfig.modelId = effectiveModelId;
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
  structuredOutputSchema: Record<string, unknown> | undefined,
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

    const effectiveModelId =
      validation.resolvedModelId ?? resolveParentModelId(ctx.orchestrator, options.parentJid) ?? '';

    const requestedLevel = options.thinkingLevel;
    const effectiveThinkingLevel =
      requestedLevel ??
      resolveParentThinkingLevel(ctx.orchestrator, options.parentJid) ??
      undefined;

    const nameToken = pickFreshNameToken(ctx);
    const folder = `agent-${nameToken}`;
    const jid = `agent_${tokenToJid(nameToken)}`;
    const scratchFolder = `/scoops/${folder}`;

    const scoopConfig = buildScoopConfig(
      options,
      effectiveModelId,
      effectiveThinkingLevel,
      scratchFolder
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
      notifyOnComplete: false,
      // Propagate the invoking scoop's JID for delegation-chain reconstruction.
      // Only set when AgentSpawnOptions.parentJid is provided; never inferred.
      ...(options.parentJid !== undefined ? { parentJid: options.parentJid } : {}),
    };

    const observerHandle = registerScoopObserver(ctx.orchestrator, jid);

    try {
      try {
        await ctx.orchestrator.registerScoop(scoop);
      } catch (err) {
        return { finalText: observerHandle.scoopError ?? errText(err), exitCode: 1 };
      }

      const result = await runScoopAndCaptureOutput(
        ctx.orchestrator,
        jid,
        options.prompt,
        options.structuredOutputSchema,
        observerHandle
      );
      if (result) return result;

      return { finalText: observerHandle.scoopError ?? '', exitCode: 1 };
    } catch (err) {
      return { finalText: observerHandle.scoopError ?? errText(err), exitCode: 1 };
    } finally {
      observerHandle.unsubscribe?.();
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
  (globalThis as Record<string, unknown>)[AGENT_BRIDGE_GLOBAL_KEY] = bridge;
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
 * Default model resolver. Returns the input id if any configured provider's
 * FULL model list advertises it; otherwise null. Validates against
 * `getProviderModels()` (the unfiltered per-provider list), NOT
 * `getAllAvailableModels()` — the latter is picker-filtered
 * (`PICKER_HIDDEN_MODEL_PATTERNS`, e.g. `/haiku/i`), so a model hidden from the
 * cone picker would be wrongly rejected here as "unknown". A picker-hidden
 * model is still a legitimate explicit sub-agent target (the very "haiku scoop
 * for cheap throwaway work" the picker hides it to avoid as a *cone* default).
 * Tests can replace this via `deps.resolveModel` without touching
 * provider-settings state.
 */
export function defaultResolveModel(modelId: string): string | null {
  try {
    for (const account of getAccounts()) {
      if (getProviderModels(account.providerId).some((m) => m.id === modelId)) return modelId;
    }
    // Try shorthand alias: keyword match against available model ids/names
    const alias = resolveModelByShorthand(modelId);
    if (alias) return alias;
    return null;
  } catch (err) {
    // getAccounts/getProviderModels normally return [] (and self-log) on a provider/parse
    // failure; the only throws that reach here are residual storage/environment faults
    // (e.g. a SecurityError, or a missing storage shim). Without a breadcrumb the caller
    // gets a misleading "unknown model: <id>" for what is really an environment fault.
    log.warn('defaultResolveModel: provider/account lookup threw; treating model as unknown', {
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function normalizeRwPrefix(path: string): string {
  const normalized = normalizePath(path);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

/**
 * Compute the visiblePaths list from spawn options.
 *
 * - `--read-only` set (any value, including `[]`): pure replace. The
 *   caller explicitly opted out of BOTH the default `/workspace/` AND
 *   the implicit `invokingCwd` add — we don't fight that.
 * - `--read-only` absent: return the default `/workspace/` unioned with
 *   the invoking shell's `ctx.cwd` (when provided), so agents launched
 *   from anywhere on the VFS can still READ the directory they were
 *   spawned from. De-duped on the normalized trailing-slash form.
 */
function resolveVisiblePaths(options: AgentSpawnOptions): string[] {
  if (options.visiblePaths !== undefined) {
    return options.visiblePaths.map(normalizeRwPrefix);
  }
  const base = ['/workspace/'];
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
