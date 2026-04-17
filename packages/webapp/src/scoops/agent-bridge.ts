/**
 * AgentBridge — direct spawn path for the `agent` supplemental shell command.
 *
 * The cone normally delegates work to scoops via the `scoop_scoop` / `feed_scoop`
 * agent tools. Those tools are cone-only and add the scoop to the persistent
 * scoops registry. The `agent` shell command needs a parallel mechanism that:
 *
 * 1. Works from any bash invocation (cone, scoop, or nested `agent` call).
 * 2. Spawns an ephemeral sub-scoop with a sandboxed `RestrictedFS`.
 * 3. Blocks until the scoop's agent loop resolves.
 * 4. Captures `send_message(text)` calls and returns the final one (or the
 *    last assistant text as a fallback).
 * 5. Cleans up the scratch folder and orchestrator registration on every
 *    completion path — success, error, or abort.
 *
 * This module owns steps 2–5. It is wired into `globalThis.__slicc_agent`
 * from the CLI/webapp bootstrap and the extension offscreen bootstrap.
 */

import type { Orchestrator } from './orchestrator.js';
import type { VirtualFS } from '../fs/index.js';
import { RestrictedFS } from '../fs/restricted-fs.js';
import { normalizePath } from '../fs/path-utils.js';
import type { SessionStore } from '../core/session.js';
import type { RegisteredScoop } from './types.js';
import type { BrowserAPI } from '../cdp/index.js';
import { ScoopContext, type ScoopContextCallbacks } from './scoop-context.js';
import { createLogger } from '../core/logger.js';
import type { AgentMessage, AssistantMessage, TextContent } from '../core/types.js';

const log = createLogger('agent-bridge');

/** Arguments accepted by {@link AgentBridge.spawn}. */
export interface AgentSpawnOptions {
  /** Absolute VFS path that becomes a R/W prefix for the spawned scoop. */
  cwd: string;
  /** Bash command allow-list (enforced elsewhere; forwarded here only for traceability). */
  allowedCommands: string[];
  /** Prompt forwarded verbatim to `ctx.prompt()`. */
  prompt: string;
  /** Optional model id override. When omitted, the parent's model is inherited. */
  modelId?: string;
  /**
   * JID of the scoop (or cone) that invoked `agent`. When provided and the
   * scoop exists in `orchestrator.getScoops()`, its `config.modelId` is used
   * for model inheritance (NOT the global UI selection). When the looked-up
   * scoop has no configured model (e.g., the cone uses the global UI model),
   * the bridge falls back to `getInheritedModelId()`. Omitted for top-level
   * terminal invocations where no scoop context owns the call.
   */
  parentJid?: string;
}

/** Result returned by {@link AgentBridge.spawn}. */
export interface AgentSpawnResult {
  /** Final text: last `send_message` payload, else last assistant text, else `''`. */
  finalText: string;
  /** 0 on success; 1 on agent-loop error or unknown-model rejection. */
  exitCode: number;
}

/** Public contract exposed on `globalThis.__slicc_agent`. */
export interface AgentBridge {
  spawn(options: AgentSpawnOptions): Promise<AgentSpawnResult>;
}

/** Minimal shape the bridge needs from a ScoopContext (used by test doubles). */
export interface AgentBridgeContext {
  init(): Promise<void>;
  prompt(text: string): Promise<void>;
  dispose(): void;
  getAgentMessages(): AgentMessage[];
}

/** Arguments passed to a `createContext` factory. */
export interface AgentBridgeContextArgs {
  scoop: RegisteredScoop;
  callbacks: ScoopContextCallbacks;
  fs: RestrictedFS;
  sharedFs: VirtualFS;
  sessionStore: SessionStore | null;
  /** Effective model id — either `modelId` or the inherited parent. */
  modelId: string;
}

/** Testability seams. Production defaults use the real ScoopContext + pi-ai. */
export interface AgentBridgeDeps {
  /** Override the ScoopContext factory (for tests). */
  createContext?: (args: AgentBridgeContextArgs) => AgentBridgeContext;
  /** Override the uid generator (for deterministic tests). */
  generateUid?: () => string;
  /**
   * Validate a model id. Returns the resolved id on success, or `null` when
   * the id is unknown. Default looks up the id across all configured providers
   * via `getAllAvailableModels()`.
   */
  resolveModel?: (modelId: string) => string | null;
  /**
   * Return the model id inherited from the parent when no explicit override
   * is supplied. Default reads from `provider-settings.resolveCurrentModel()`.
   */
  getInheritedModelId?: () => string;
  /** BrowserAPI provider threaded through to the spawned ScoopContext. */
  getBrowserAPI?: () => BrowserAPI;
}

/**
 * Create an {@link AgentBridge} bound to the given orchestrator + shared VFS.
 *
 * @param orchestrator  The application orchestrator. Used to unregister the
 *                      spawned scoop during cleanup (safe even if the scoop
 *                      was never formally registered).
 * @param sharedFs      The shared VirtualFS. Used to (a) create/delete the
 *                      scratch folder and (b) construct the scoop's
 *                      {@link RestrictedFS}.
 * @param sessionStore  Optional session store. When provided, `spawn()` will
 *                      call `sessionStore.delete(jid)` during cleanup.
 * @param deps          Testability seams — see {@link AgentBridgeDeps}.
 */
export function createAgentBridge(
  orchestrator: Orchestrator,
  sharedFs: VirtualFS,
  sessionStore: SessionStore | null | undefined = null,
  deps: AgentBridgeDeps = {}
): AgentBridge {
  const createContext: (args: AgentBridgeContextArgs) => AgentBridgeContext =
    deps.createContext ??
    ((args) => {
      // Default: construct a real ScoopContext. The scoop's modelId is
      // conveyed via `scoop.config.modelId` and resolved in ScoopContext.init()
      // via `resolveModelById`.
      return new ScoopContext(
        args.scoop,
        args.callbacks,
        args.fs,
        args.sessionStore ?? undefined,
        args.sharedFs
      );
    });
  const generateUid = deps.generateUid ?? defaultGenerateUid;
  const resolveModel = deps.resolveModel ?? defaultResolveModel;
  const getInheritedModelId = deps.getInheritedModelId ?? defaultGetInheritedModelId;
  const getBrowserAPI = deps.getBrowserAPI ?? (() => ({}) as BrowserAPI);

  /**
   * Look up the parent scoop by `jid` in the orchestrator registry and return
   * its configured model id. Returns `null` when:
   *   - `parentJid` is `undefined` (top-level invocation).
   *   - The parent is not found in `orchestrator.getScoops()`.
   *   - The parent exists but has no `config.modelId` (e.g., the cone, which
   *     tracks the global UI selection through `resolveCurrentModel()`).
   *
   * `null` signals "continue to the next precedence tier" in the caller's
   * `??` chain — typically falling back to `getInheritedModelId()`.
   */
  function resolveParentModelId(parentJid: string | undefined): string | null {
    if (parentJid === undefined) return null;
    const parent = orchestrator.getScoops().find((s) => s.jid === parentJid);
    if (!parent) return null;
    const modelId = parent.config?.modelId;
    return modelId && modelId.length > 0 ? modelId : null;
  }

  async function spawn(options: AgentSpawnOptions): Promise<AgentSpawnResult> {
    const requestedModelId = options.modelId;

    // Model validation happens BEFORE any scratch folder / context creation so
    // that the unknown-model path is a clean no-op.
    if (requestedModelId !== undefined) {
      if (requestedModelId === '' || resolveModel(requestedModelId) === null) {
        return {
          finalText: `agent: unknown model: ${requestedModelId}`,
          exitCode: 1,
        };
      }
    }

    // Model inheritance precedence (highest priority first):
    //   1. Explicit `--model` override (`requestedModelId`).
    //   2. Parent scoop's `config.modelId`, looked up by `parentJid` in the
    //      orchestrator registry. This is the key path for model inheritance
    //      across nested `agent` invocations from inside a scoop's bash tool.
    //   3. `getInheritedModelId()` — the global UI selection (fallback used
    //      when the parent is the cone with no configured model, the parent
    //      is unknown, or no `parentJid` was supplied).
    const effectiveModelId =
      requestedModelId ?? resolveParentModelId(options.parentJid) ?? getInheritedModelId();

    // Mint a unique folder + jid.
    const uid = generateUid();
    const folder = `agent-${uid}`;
    const jid = `agent_${uid}`;
    const scoopFolderPath = `/scoops/${folder}`;
    const scoopFolderPathTrailing = `${scoopFolderPath}/`;

    // Create the scratch folder before anything else so that the RestrictedFS
    // constructor + the agent loop can both assume it exists.
    try {
      await sharedFs.mkdir(scoopFolderPath, { recursive: true });
    } catch (err) {
      return {
        finalText: `agent: failed to create scratch folder: ${errText(err)}`,
        exitCode: 1,
      };
    }

    // Build the scoop record. We do NOT call `orchestrator.registerScoop()`
    // because that spins up a full ScoopContext via `createScoopTab` — we own
    // the context directly. Instead we register the already-built record via
    // `registerExistingScoop()` so the ephemeral scoop is visible through
    // `orchestrator.getScoops()` while its run is in flight. The cleanup path
    // below calls `unregisterScoop(jid)` which removes the entry again.
    //
    // The bash allow-list is forwarded into `config.allowedCommands`. The
    // ScoopContext picks it up during `init()` and wraps its bash tool with
    // `wrapBashToolWithAllowlist` (wildcard `*` remains a passthrough — the
    // wrapper returns the original tool unchanged in that case).
    //
    // Persist `effectiveModelId` (NOT just the explicit request) onto
    // `config.modelId` so the REAL `ScoopContext.init()` path — which reads
    // from `this.scoop.config?.modelId` to choose `resolveModelById()` vs
    // `resolveCurrentModel()` — honors the parent-inherited model. Without
    // this copy, the bridge-computed `effectiveModelId` was only observable
    // through the `AgentBridgeContextArgs.modelId` seam (which only mocked
    // tests inspect), and production always fell back to the global UI
    // selection. Leave `modelId` UNSET when `effectiveModelId` is empty so
    // the cone-no-model path still falls back through ScoopContext's
    // existing `resolveCurrentModel()` branch.
    const now = new Date().toISOString();
    const scoopConfig: RegisteredScoop['config'] = {};
    if (effectiveModelId) scoopConfig.modelId = effectiveModelId;
    scoopConfig.allowedCommands = options.allowedCommands;
    const scoop: RegisteredScoop = {
      jid,
      name: folder,
      folder,
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: folder,
      addedAt: now,
      config: scoopConfig,
    };

    // Insert the ephemeral scoop into the orchestrator's registry so it is
    // visible via `orchestrator.getScoops()` for the duration of the run.
    // This does NOT create a ScoopContext — the bridge owns the context
    // directly via `createContext` below.
    orchestrator.registerExistingScoop(scoop);

    // Build the sandboxed FS.
    const cwdPrefix = normalizeRwPrefix(options.cwd);
    const fs = new RestrictedFS(
      sharedFs,
      [cwdPrefix, '/shared/', scoopFolderPathTrailing],
      ['/workspace/']
    );

    // Collect `send_message` payloads; the latest one wins for final output.
    const captured: string[] = [];
    const callbacks: ScoopContextCallbacks = {
      onResponse: () => {},
      onResponseDone: () => {},
      onError: (errMsg) => {
        log.warn('scoop error', { jid, errMsg });
      },
      // Propagate scope-context status transitions to the orchestrator's
      // `onStatusChange` callback pipeline so the UI panels (side-panel
      // `ScoopsPanel` + CLI scoop panel) refresh and show the bridge scoop
      // during its run. See VAL-SPAWN-015.
      onStatusChange: (status) => {
        orchestrator.updateBridgeTabStatus(jid, status);
      },
      onSendMessage: (text) => {
        captured.push(text);
      },
      getScoops: () => orchestrator.getScoops(),
      getGlobalMemory: async () => '',
      getBrowserAPI,
    };

    let ctx: AgentBridgeContext | null = null;
    let finalText = '';
    let exitCode = 0;

    try {
      ctx = createContext({
        scoop,
        callbacks,
        fs,
        sharedFs,
        sessionStore: sessionStore ?? null,
        modelId: effectiveModelId,
      });
      await ctx.init();
      // Drive the visible bridge-tab status from 'initializing' →
      // 'processing' so the UI panel shows the in-flight state even when
      // the underlying ScoopContext doesn't emit its own transitions
      // (e.g., simple mock contexts or certain error paths). Safe to fire
      // even if the context also emits the same transition — the tab's
      // lastActivity just refreshes on both.
      orchestrator.updateBridgeTabStatus(jid, 'processing');
      await ctx.prompt(options.prompt);

      if (captured.length > 0) {
        finalText = captured[captured.length - 1];
      } else {
        const messages = ctx.getAgentMessages();
        finalText = extractLastAssistantText(messages);
      }
    } catch (err) {
      exitCode = 1;
      finalText = errText(err);
    } finally {
      // 1. Dispose the context (best-effort; never re-throws).
      try {
        ctx?.dispose();
      } catch (err) {
        log.warn('ctx.dispose() threw', { jid, error: errText(err) });
      }

      // 2. Unregister from orchestrator — safe even if the scoop was never
      //    formally registered; `unregisterScoop` tolerates missing entries.
      try {
        await orchestrator.unregisterScoop(jid);
      } catch (err) {
        log.warn('orchestrator.unregisterScoop failed', { jid, error: errText(err) });
      }

      // 3. Delete the scratch folder from the VFS. Only this folder is touched
      //    — siblings, /shared/, /workspace/, and the caller-supplied cwd are
      //    left intact (enforced via path targeting, not RestrictedFS).
      try {
        await sharedFs.rm(scoopFolderPath, { recursive: true });
      } catch (err) {
        log.warn('scratch folder cleanup failed', { folder, error: errText(err) });
      }

      // 4. Delete session store entry, if one exists.
      if (sessionStore) {
        try {
          await sessionStore.delete(jid);
        } catch (err) {
          log.warn('sessionStore.delete failed', { jid, error: errText(err) });
        }
      }
    }

    return { finalText, exitCode };
  }

  return { spawn };
}

/** Global hook name used by {@link publishAgentBridge} and read by the
 *  `agent` supplemental command via `globalThis.__slicc_agent`. */
export const AGENT_BRIDGE_GLOBAL_KEY = '__slicc_agent';

/**
 * Message `type` tag used on the wire when the extension side-panel proxy
 * relays a spawn request to the offscreen document's real bridge.
 *
 * Both ends agree on this literal: the panel publishes a proxy via
 * {@link publishAgentBridgeProxy} that posts `{ source: 'panel', payload:
 * { type: AGENT_SPAWN_REQUEST_TYPE, options } }` through
 * `chrome.runtime.sendMessage`, and the offscreen document's message
 * listener dispatches on the same tag, awaits `globalThis.__slicc_agent
 * .spawn(options)`, and returns the result via `sendResponse`.
 */
export const AGENT_SPAWN_REQUEST_TYPE = 'agent-spawn-request';

/**
 * Bootstrap helper: create an {@link AgentBridge} for the given orchestrator
 * and publish it to `globalThis.__slicc_agent` so the `agent` supplemental
 * shell command can find it.
 *
 * This is the only sanctioned way to publish the hook. Both CLI bootstrap
 * (`packages/webapp/src/ui/main.ts`) and extension-offscreen bootstrap
 * (`packages/chrome-extension/src/offscreen.ts`) call this helper AFTER
 * `orchestrator.init()` has resolved (so `sharedFs` is available) and BEFORE
 * the WasmShell registers its supplemental commands.
 *
 * Call sites must guarantee that `sharedFs` is non-null — i.e. `init()` has
 * already completed. If `init()` rejects, this helper MUST NOT be invoked,
 * so that `globalThis.__slicc_agent` is never left in a half-initialized
 * state.
 *
 * @returns The published {@link AgentBridge} (same reference as `globalThis.__slicc_agent`).
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

/**
 * Shape of the response the extension offscreen document sends back through
 * `sendResponse` after handling an {@link AGENT_SPAWN_REQUEST_TYPE} message.
 *
 * Kept narrow so the proxy does not depend on chrome-extension types; the
 * canonical envelope lives in `packages/chrome-extension/src/messages.ts`.
 */
interface AgentSpawnProxyResponse {
  /** Whether the offscreen bridge successfully returned a result. */
  ok: boolean;
  /** Present only when `ok === true`. */
  result?: AgentSpawnResult;
  /** Present only when `ok === false`. */
  error?: string;
}

/**
 * Minimal Chrome runtime surface required by {@link publishAgentBridgeProxy}.
 *
 * We keep this intentionally narrow so the proxy stays testable under any
 * stub (including `vi.stubGlobal('chrome', ...)`). The full `chrome.runtime`
 * API is much wider but we only rely on `lastError` and `sendMessage`.
 */
interface ChromeRuntimeForProxy {
  runtime: {
    lastError?: { message?: string } | null;
    sendMessage(message: unknown, callback?: (response: unknown) => void): unknown;
  };
}

/**
 * Publish a PROXY {@link AgentBridge} on `globalThis.__slicc_agent` for use
 * in the extension side-panel realm.
 *
 * Context:
 *   The extension has two execution contexts with independent globals (see
 *   `packages/chrome-extension/CLAUDE.md`): the side panel (UI + terminal
 *   shell) and the offscreen document (agent engine + the REAL bridge
 *   published via {@link publishAgentBridge}). The panel does NOT own an
 *   Orchestrator, so it cannot publish the real bridge — yet the panel's
 *   WasmShell still runs the `agent` supplemental command which looks up
 *   `globalThis.__slicc_agent` on the panel realm.
 *
 * Behavior:
 *   The returned bridge's `spawn()` forwards its options through
 *   `chrome.runtime.sendMessage(...)` tagged with
 *   {@link AGENT_SPAWN_REQUEST_TYPE}; the offscreen side dispatches the call
 *   into its own `globalThis.__slicc_agent.spawn(options)` and replies via
 *   `sendResponse`. The proxy awaits that reply and resolves / rejects the
 *   promise accordingly.
 *
 * Failure modes:
 *   - `chrome.runtime` missing at call time → rejects with a descriptive Error.
 *   - `chrome.runtime.lastError` populated after the callback → rejects.
 *   - Offscreen responds `{ ok: false, error }` → rejects with `error`.
 *   - Offscreen responds with `{ ok: true }` but no `result` → rejects.
 *   - Offscreen callback invoked with `undefined` response → rejects.
 *
 * Intentionally does NOT validate options client-side — the offscreen
 * bridge is the single source of truth for spawn semantics (model
 * validation, scratch-folder creation, etc.).
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
          // Read lastError FIRST — chrome clears it after each callback turn.
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
 * Default model resolver. Returns the input id if any provider in the current
 * registry advertises a matching model; otherwise returns null.
 *
 * We intentionally go through `provider-settings.getAllAvailableModels()`
 * instead of pi-ai's `getModel` — the former reflects the user's actual
 * configured accounts AND layered overrides, the latter would pass ids that
 * the user has not configured.
 */
function defaultResolveModel(modelId: string): string | null {
  if (!modelId) return null;
  try {
    // Dynamic import via require-esque path to avoid circular dependency with
    // provider-settings pulling in DOM-bound code at module load.

    const { getAllAvailableModels } = require('../ui/provider-settings.js') as {
      getAllAvailableModels: () => Array<{ models: Array<{ id: string }> }>;
    };
    const groups = getAllAvailableModels();
    for (const g of groups) {
      for (const m of g.models) {
        if (m.id === modelId) return modelId;
      }
    }
  } catch {
    /* provider-settings may not be initialized (tests inject their own resolver) */
  }
  return null;
}

function defaultGetInheritedModelId(): string {
  try {
    const { resolveCurrentModel } = require('../ui/provider-settings.js') as {
      resolveCurrentModel: () => { id: string };
    };
    return resolveCurrentModel().id;
  } catch {
    return '';
  }
}

function normalizeRwPrefix(path: string): string {
  const normalized = normalizePath(path || '/');
  return normalized.endsWith('/') ? normalized : normalized + '/';
}

function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const assistant = msg as AssistantMessage;
      const parts = assistant.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text);
      if (parts.length > 0) return parts.join('');
    }
  }
  return '';
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
