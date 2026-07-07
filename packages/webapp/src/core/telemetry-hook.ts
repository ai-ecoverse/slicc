/**
 * Worker-safe telemetry hook for agent-loop errors.
 *
 * The agent loop (a low layer in the stack) must not import the UI's
 * `ui/telemetry.ts` directly — it reaches `window` / `localStorage` /
 * `@adobe/helix-rum-js` in branches the worker realm never takes, and
 * a direct import would also push `scoops/scoop-context.ts` into the
 * no-DOM typecheck guard (`tsconfig.webapp-worker.json`).
 *
 * Instead, agent-loop error sites emit through this dependency-inversion
 * sink: the UI registers `trackError` via `setAgentErrorTelemetrySink`
 * during `initTelemetry()`, and the agent loop calls `emitAgentError`
 * with no knowledge of the UI. When no sink is registered (worker realm
 * before the page-side init runs, or a host that never calls `initTelemetry`),
 * emits are silently dropped — telemetry is best-effort.
 *
 * Mirrors `shell/telemetry-hook.ts` (the same pattern for shell-command
 * beacons).
 */

export type AgentErrorSource = 'llm' | 'tool';

export type AgentErrorTelemetrySink = (source: AgentErrorSource, details: string) => void;

let sink: AgentErrorTelemetrySink | null = null;

/** Register (or clear with `null`) the agent-error telemetry sink. */
export function setAgentErrorTelemetrySink(fn: AgentErrorTelemetrySink | null): void {
  sink = fn;
}

/** Emit an agent-loop error through the registered sink. No-op if unset. */
export function emitAgentError(source: AgentErrorSource, details: string): void {
  sink?.(source, details);
}
