/**
 * Worker-safe telemetry hook for scoop lifecycle events.
 *
 * The scoops layer (orchestrator + scoop-context) sits below the UI in
 * the layer stack and must not import `ui/telemetry.ts`, which reaches
 * `window`, `localStorage`, and `@adobe/helix-rum-js`. That back-edge
 * would also pull the worker-resident scoops code out of the no-DOM
 * typecheck guard (`tsconfig.webapp-worker.json`).
 *
 * Mirrors the `shell/telemetry-hook.ts` pattern: the UI registers a
 * sink during `initTelemetry()`, and the scoops layer calls
 * `emitScoopLifecycle` with no knowledge of the UI. When no sink is
 * registered (worker float without a page-side telemetry init), emits
 * are dropped.
 */

export type ScoopLifecycleEvent = 'spawn' | 'feed' | 'complete' | 'error';

type ScoopTelemetrySink = (event: ScoopLifecycleEvent, scoopName: string, details?: string) => void;

let sink: ScoopTelemetrySink | null = null;

/** Register (or clear with `null`) the scoop lifecycle telemetry sink. */
export function setScoopTelemetrySink(fn: ScoopTelemetrySink | null): void {
  sink = fn;
}

/**
 * Emit a scoop lifecycle event through the registered sink. `scoopName`
 * is the scoop folder (used as the source attribution in RUM). `details`
 * is an optional free-form payload — currently only the `error` event
 * uses it, to carry the sanitized error message.
 */
export function emitScoopLifecycle(
  event: ScoopLifecycleEvent,
  scoopName: string,
  details?: string
): void {
  sink?.(event, scoopName, details);
}
