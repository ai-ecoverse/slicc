/**
 * Agent-bridge bootstrap helpers — one per runtime realm.
 *
 * Background
 * ----------
 * The `agent` supplemental shell command looks up its scoop-spawning
 * transport on `globalThis.__slicc_agent`. That hook MUST be published from
 * every runtime that owns an {@link Orchestrator} so the terminal shell in
 * that realm can find a working bridge. In this repo the relevant realms
 * are:
 *
 *   1. **CLI realm** — standalone / Electron-overlay webapp. The page's
 *      Orchestrator is constructed in `packages/webapp/src/ui/main.ts`.
 *      {@link bootstrapAgentBridgeCli} is the canonical publish call site
 *      for this realm.
 *
 *   2. **Extension offscreen realm** — the Manifest V3 offscreen document
 *      that hosts the persistent agent engine. Its Orchestrator is
 *      constructed in `packages/chrome-extension/src/offscreen.ts`.
 *      {@link bootstrapAgentBridgeOffscreen} is the canonical publish call
 *      site for this realm.
 *
 * Both helpers wrap {@link publishAgentBridge} so each realm can evolve its
 * own pre/post-conditions (extra listeners, different model-resolution
 * plumbing, etc.) without the other realm silently inheriting the change.
 * Keeping them in a shared file means the cross-realm parity tests can
 * import both by name and exercise genuinely distinct code paths (even if
 * today the bodies are intentionally symmetric).
 *
 * Tests
 * -----
 * `packages/webapp/tests/scoops/agent-integration.test.ts` imports both
 * helpers to verify that:
 *   - each helper calls `publishAgentBridge` exactly once,
 *   - each publishes the hook on `globalThis.__slicc_agent`,
 *   - and a command driven through each bridge produces byte-identical
 *     stdout/stderr/exitCode and cleanup outcomes.
 *
 * If a future change diverges the two call sites (e.g. CLI starts passing
 * an extra dep the offscreen path doesn't), the parity test will fail at
 * the helper boundary rather than silently passing under a shared wrapper.
 */

import type { Orchestrator } from './orchestrator.js';
import { publishAgentBridge, type AgentBridge, type AgentBridgeDeps } from './agent-bridge.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('agent-bridge-bootstrap');

/**
 * Publish the AgentBridge for the **CLI realm**.
 *
 * Call site: `packages/webapp/src/ui/main.ts` — invoked once, AFTER
 * `orchestrator.init()` resolves so `sharedFs` is populated, and BEFORE
 * the WasmShell registers supplemental commands so the `agent` command
 * can resolve `globalThis.__slicc_agent` on its first lookup.
 *
 * Throws synchronously if the orchestrator has not yet initialized —
 * callers MUST NOT publish a half-initialized hook.
 */
export function bootstrapAgentBridgeCli(
  orchestrator: Orchestrator,
  deps: AgentBridgeDeps = {}
): AgentBridge {
  const sharedFs = orchestrator.getSharedFS();
  if (!sharedFs) {
    throw new Error(
      'bootstrapAgentBridgeCli: orchestrator.getSharedFS() is null; did you forget to await orchestrator.init()?'
    );
  }
  const bridge = publishAgentBridge(orchestrator, sharedFs, orchestrator.getSessionStore(), deps);
  log.info('CLI-realm agent bridge published');
  return bridge;
}

/**
 * Publish the AgentBridge for the **extension offscreen realm**.
 *
 * Call site: `packages/chrome-extension/src/offscreen.ts` — invoked once,
 * AFTER `orchestrator.init()` resolves so `sharedFs` is populated, and
 * BEFORE the chrome.runtime listener that proxies panel-originated spawn
 * requests starts dispatching them to `globalThis.__slicc_agent.spawn`.
 *
 * Throws synchronously if the orchestrator has not yet initialized. The
 * caller is expected to log and continue (the offscreen realm logs a
 * warning rather than crashing the whole engine if this helper rejects).
 */
export function bootstrapAgentBridgeOffscreen(
  orchestrator: Orchestrator,
  deps: AgentBridgeDeps = {}
): AgentBridge {
  const sharedFs = orchestrator.getSharedFS();
  if (!sharedFs) {
    throw new Error(
      'bootstrapAgentBridgeOffscreen: orchestrator.getSharedFS() is null; did you forget to await orchestrator.init()?'
    );
  }
  const bridge = publishAgentBridge(orchestrator, sharedFs, orchestrator.getSessionStore(), deps);
  log.info('Offscreen-realm agent bridge published');
  return bridge;
}
