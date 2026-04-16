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

    const effectiveModelId = requestedModelId ?? getInheritedModelId();

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

    // Build the scoop record. We do NOT add it to `orchestrator.registerScoop`
    // because that spins up a full ScoopContext via `createScoopTab`. We own
    // the context directly. `unregisterScoop` is still called during cleanup
    // as a defensive no-op in case anything upstream tracks the jid.
    const now = new Date().toISOString();
    const scoop: RegisteredScoop = {
      jid,
      name: folder,
      folder,
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: folder,
      addedAt: now,
      config: requestedModelId !== undefined ? { modelId: requestedModelId } : undefined,
    };

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
      onStatusChange: () => {},
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
