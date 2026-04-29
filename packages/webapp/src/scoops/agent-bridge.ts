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
 * — those all live in the orchestrator / `ScoopConfig` / `WasmShell`
 * layers now. Compare against the original #430 implementation (~770 LOC
 * of bridge alone) to see the effect of that consolidation.
 */

import type { Orchestrator } from './orchestrator.js';
import type { VirtualFS } from '../fs/index.js';
import { normalizePath } from '../fs/path-utils.js';
import type { SessionStore } from '../core/session.js';
import {
  CURRENT_SCOOP_CONFIG_VERSION,
  isThinkingLevel,
  THINKING_LEVELS,
  type RegisteredScoop,
  type ThinkingLevel,
} from './types.js';
import { createLogger } from '../core/logger.js';
import { getAllAvailableModels } from '../ui/provider-settings.js';

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
   * Validation of the literal value happens in
   * `agent-command.ts` (`--thinking` flag) — the bridge trusts callers
   * to supply a valid {@link ThinkingLevel}.
   */
  thinkingLevel?: ThinkingLevel;
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
   * Default looks up via `getAllAvailableModels()` from provider-settings.
   */
  resolveModel?: (modelId: string) => string | null;
}

/** Global hook name used by {@link publishAgentBridge}. */
export const AGENT_BRIDGE_GLOBAL_KEY = '__slicc_agent';

/**
 * Message `type` tag used on the wire when the extension side-panel proxy
 * relays a spawn request to the offscreen document's real bridge. Both ends
 * of the Manifest V3 boundary agree on this literal — see
 * {@link publishAgentBridgeProxy} and
 * `packages/chrome-extension/src/offscreen-bridge.ts`.
 */
export const AGENT_SPAWN_REQUEST_TYPE = 'agent-spawn-request';

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
  const generateName = deps.generateName ?? defaultGenerateName;
  const generateUid = deps.generateUid ?? defaultGenerateUid;
  const resolveModel = deps.resolveModel ?? defaultResolveModel;

  /**
   * Pick a fresh `<adjective>-<flavor>` that doesn't collide with any
   * currently-registered scoop jid. If we get unlucky eight times in a
   * row, fall back to the hex uid generator so we never infinite-loop.
   */
  function pickFreshNameToken(): string {
    const MAX_TRIES = 8;
    for (let i = 0; i < MAX_TRIES; i++) {
      const candidate = generateName();
      const candidateJid = `agent_${tokenToJid(candidate)}`;
      if (!orchestrator.getScoops().some((s) => s.jid === candidateJid)) {
        return candidate;
      }
    }
    return generateUid();
  }

  /**
   * Look up the parent scoop by jid in the orchestrator registry and return
   * its configured `modelId`. Returns `null` when parent is missing or has
   * no `config.modelId` — typical for the cone, which tracks the UI
   * selection through `ScoopContext.init()` instead of storing it.
   */
  function resolveParentModelId(parentJid: string | undefined): string | null {
    if (parentJid === undefined) return null;
    const parent = orchestrator.getScoops().find((s) => s.jid === parentJid);
    if (!parent) return null;
    const modelId = parent.config?.modelId;
    return modelId && modelId.length > 0 ? modelId : null;
  }

  /**
   * Mirror of {@link resolveParentModelId} for `thinkingLevel`. Returns
   * `null` when the parent is missing or has no `config.thinkingLevel`.
   * The cone never stores its level here either — it lives on the cone's
   * live `agent.state.thinkingLevel`, which the chat-panel UI mutates
   * directly. Ephemeral `agent` invocations from the cone therefore
   * default to `undefined` here and let `ScoopContext.init()` fall back
   * to `'off'` unless the caller passed `--thinking <level>`.
   */
  function resolveParentThinkingLevel(parentJid: string | undefined): ThinkingLevel | null {
    if (parentJid === undefined) return null;
    const parent = orchestrator.getScoops().find((s) => s.jid === parentJid);
    if (!parent) return null;
    const level = parent.config?.thinkingLevel;
    return level && isThinkingLevel(level) ? level : null;
  }

  async function spawn(options: AgentSpawnOptions): Promise<AgentSpawnResult> {
    // Model validation first. An explicit `--model foo` with no matching
    // provider is a clean no-op — we never create the scratch folder or
    // register a scoop when the model id is unknown.
    const requestedModelId = options.modelId;
    if (requestedModelId !== undefined) {
      if (requestedModelId === '' || resolveModel(requestedModelId) === null) {
        return {
          finalText: `agent: unknown model: ${requestedModelId}`,
          exitCode: 1,
        };
      }
    }

    // Model precedence: explicit > parent scoop > undefined (ScoopContext
    // then falls back to the UI selection via `resolveCurrentModel`).
    const effectiveModelId = requestedModelId ?? resolveParentModelId(options.parentJid) ?? '';

    // Validate explicit thinkingLevel up-front. agent-command.ts already
    // rejects unknown values, but defense-in-depth: programmatic callers
    // (and the extension proxy) reach this path too.
    const requestedLevel = options.thinkingLevel;
    if (requestedLevel !== undefined && !isThinkingLevel(requestedLevel)) {
      return {
        finalText: `agent: invalid thinking level: ${String(requestedLevel)} (one of: ${THINKING_LEVELS.join(', ')})`,
        exitCode: 1,
      };
    }

    // Thinking-level precedence mirrors model precedence:
    //   explicit > parent scoop > undefined (ScoopContext resolves
    //   undefined to 'off' via `resolveThinkingLevel`).
    const effectiveThinkingLevel =
      requestedLevel ?? resolveParentThinkingLevel(options.parentJid) ?? undefined;

    // Friendly `<adjective>-<flavor>` naming (on-brand with the ice-cream
    // vocabulary). Folder uses dashes; jid uses underscores. Falls back
    // to the old hex uid if we hit eight consecutive collisions.
    const nameToken = pickFreshNameToken();
    const folder = `agent-${nameToken}`;
    const jid = `agent_${tokenToJid(nameToken)}`;
    const scratchFolder = `/scoops/${folder}`;

    // Normalize the caller-supplied cwd into a RestrictedFS-compatible
    // prefix (trailing slash required by the prefix-match semantics).
    const cwdPrefix = normalizeRwPrefix(options.cwd);

    // Resolve visiblePaths:
    //   - Explicit `--read-only` list → pure replace (no implicit
    //     `invokingCwd` add). Mirrors `scoop_scoop` semantics exactly;
    //     the user is opting out of the default.
    //   - No `--read-only` → union of the historical default
    //     `['/workspace/']` with the caller's invokingCwd (when present
    //     and not already covered by the default), so the spawned scoop
    //     can READ the directory it was launched from. De-duped on the
    //     normalized trailing-slash prefix so repeating callers don't
    //     bloat the list.
    const visiblePaths = resolveVisiblePaths(options);

    // Resolve writablePaths: the positional cwd and /shared/ plus the
    // scoop's own scratch folder (historical), AND `/tmp/` — an always-on
    // ambient scratch root. `/tmp/` is NOT reachable via any flag; it's
    // present here unconditionally so agents always have a writable
    // temp-file location without the caller having to opt in.
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
      // Ephemeral scoops: we already drain send_message / response via
      // `observeScoop` below, so the orchestrator's default cone-notify
      // side effect would only duplicate that work and bill an extra cone
      // turn. See `RegisteredScoop.notifyOnComplete` for details.
      notifyOnComplete: false,
    };

    // Observer state. The orchestrator's per-scoop observer fires these
    // callbacks synchronously from the normal `OrchestratorCallbacks`
    // chain, so we never race the scoop's lifecycle.
    const sendMessages: string[] = [];
    let responseBuffer = '';
    let scoopError: string | null = null;

    const unsubscribe = orchestrator.observeScoop(jid, {
      onSendMessage: (text) => {
        sendMessages.push(text);
      },
      onResponse: (text, isPartial) => {
        // Mirror the orchestrator's `scoopResponseBuffer` semantics:
        // partial deltas accumulate, non-partial replaces (for non-stream
        // providers that emit the full text once).
        if (isPartial) {
          responseBuffer += text;
        } else {
          responseBuffer = text;
        }
      },
      onError: (errMsg) => {
        // Preserve the first specific error over later generic follow-ups
        // (e.g., "Agent not initialized" after an init failure). This is
        // the `scoopError` preservation that #430 accrued over three
        // rounds of live-testing; we keep the semantic but collapse the
        // machinery to a single `??` below.
        if (scoopError === null) {
          scoopError = errMsg;
        }
      },
    });

    try {
      // registerScoop awaits createScoopTab (post-#441), so init races
      // are impossible. If init fails, ScoopContext surfaces the error
      // through `onError` (captured above) and registerScoop itself
      // rolls back the in-memory + on-disk records.
      try {
        await orchestrator.registerScoop(scoop);
      } catch (err) {
        return { finalText: scoopError ?? errText(err), exitCode: 1 };
      }

      // sendPrompt runs the agent loop to completion. Errors surface via
      // the observer above rather than as a rejection (pi-agent-core
      // treats stream `error` events as terminal but non-throwing).
      await orchestrator.sendPrompt(jid, options.prompt, 'agent', 'agent');

      if (scoopError !== null) {
        return { finalText: scoopError, exitCode: 1 };
      }

      const finalText =
        sendMessages.length > 0 ? sendMessages[sendMessages.length - 1] : responseBuffer;
      return { finalText, exitCode: 0 };
    } catch (err) {
      // Any thrown error from sendPrompt (rare — usually surfaces via
      // onError) falls through here.
      return { finalText: scoopError ?? errText(err), exitCode: 1 };
    } finally {
      unsubscribe();

      // Cleanup is best-effort and never throws. Each step logs a warning
      // on failure but doesn't abort subsequent steps — leaving a partial
      // unregister is worse than a loud but survivable cleanup error.
      try {
        await orchestrator.unregisterScoop(jid);
      } catch (err) {
        log.warn('unregisterScoop failed', { jid, error: errText(err) });
      }
      try {
        await sharedFs.rm(scratchFolder, { recursive: true });
      } catch (err) {
        // ENOENT is expected when registerScoop rolled back before the
        // scratch folder was ever created (ScoopContext.init() creates it
        // on first write). Don't pollute logs with that case — surface
        // anything else (EACCES, EBUSY, etc.) since it could indicate a
        // real cleanup failure.
        if (!isFsErrorCode(err, 'ENOENT')) {
          log.warn('scratch folder cleanup failed', { folder, error: errText(err) });
        }
      }
      if (sessionStore) {
        try {
          await sessionStore.delete(jid);
        } catch (err) {
          log.warn('sessionStore.delete failed', { jid, error: errText(err) });
        }
      }
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

// ─── Extension side-panel proxy ───────────────────────────────────────

/** Response envelope the offscreen document returns via `sendResponse`. */
interface AgentSpawnProxyResponse {
  ok: boolean;
  result?: AgentSpawnResult;
  error?: string;
}

/** Narrow Chrome runtime surface the proxy relies on. */
interface ChromeRuntimeForProxy {
  runtime: {
    lastError?: { message?: string } | null;
    sendMessage(message: unknown, callback?: (response: unknown) => void): unknown;
  };
}

/**
 * Publish a proxy bridge in the extension side-panel realm. The panel has
 * no orchestrator of its own (see `packages/chrome-extension/CLAUDE.md`),
 * so it forwards spawn requests to the offscreen document, where the real
 * bridge was published via {@link publishAgentBridge}.
 *
 * The proxy is intentionally minimal: it doesn't validate options (the
 * offscreen bridge is the single source of truth) and doesn't retain any
 * state between calls. Each `spawn()` is an isolated `chrome.runtime
 * .sendMessage` round-trip.
 */
export function publishAgentBridgeProxy(): AgentBridge {
  const bridge: AgentBridge = {
    spawn(options: AgentSpawnOptions): Promise<AgentSpawnResult> {
      return new Promise<AgentSpawnResult>((resolve, reject) => {
        const chromeGlobal = (globalThis as unknown as { chrome?: ChromeRuntimeForProxy }).chrome;
        const runtime = chromeGlobal?.runtime;
        if (!runtime || typeof runtime.sendMessage !== 'function') {
          reject(new Error('agent: chrome.runtime.sendMessage not available'));
          return;
        }

        const handleResponse = (response: unknown): void => {
          // Read lastError BEFORE anything else — chrome clears it after
          // each callback turn.
          const lastError = runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message ?? 'chrome.runtime error'));
            return;
          }
          if (response === undefined || response === null) {
            reject(new Error('agent: empty response from offscreen bridge'));
            return;
          }
          const resp = response as AgentSpawnProxyResponse;
          if (!resp.ok) {
            reject(new Error(resp.error ?? 'agent: offscreen bridge error'));
            return;
          }
          if (!resp.result) {
            reject(new Error('agent: offscreen bridge returned no result'));
            return;
          }
          resolve(resp.result);
        };

        try {
          runtime.sendMessage(
            {
              source: 'panel' as const,
              payload: { type: AGENT_SPAWN_REQUEST_TYPE, options },
            },
            handleResponse
          );
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
  };
  (globalThis as Record<string, unknown>)[AGENT_BRIDGE_GLOBAL_KEY] = bridge;
  log.info('agent bridge proxy published on globalThis.__slicc_agent');
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
 * Default model resolver. Returns the input id if any configured provider
 * advertises a matching model; otherwise null. Tests can replace this via
 * `deps.resolveModel` without touching provider-settings state.
 */
function defaultResolveModel(modelId: string): string | null {
  try {
    const groups = getAllAvailableModels();
    for (const group of groups) {
      if (group.models.some((m) => m.id === modelId)) return modelId;
    }
    return null;
  } catch {
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
