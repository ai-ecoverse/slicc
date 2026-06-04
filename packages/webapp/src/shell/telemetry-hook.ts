/**
 * Worker-safe telemetry hook for the shell layer.
 *
 * The shell (a low layer in the stack) must not import the UI's
 * `ui/telemetry.ts`, which reaches `window`, `localStorage`, and
 * `@adobe/helix-rum-js` — a back-edge against the layer stack that
 * also keeps the worker-resident shell out of the no-DOM typecheck
 * guard (`tsconfig.webapp-worker.json`).
 *
 * Instead, the shell emits through this dependency-inversion sink:
 * the UI registers `trackShellCommand` via `setShellTelemetrySink`
 * during `initTelemetry()`, and the shell calls `emitShellCommand`
 * with no knowledge of the UI. When no sink is registered (worker
 * float without a page-side telemetry init), emits are dropped.
 */

type ShellTelemetrySink = (commandName: string) => void;

let sink: ShellTelemetrySink | null = null;

/** Register (or clear with `null`) the shell telemetry sink. */
export function setShellTelemetrySink(fn: ShellTelemetrySink | null): void {
  sink = fn;
}

/** Emit a shell-command telemetry event through the registered sink. */
export function emitShellCommand(commandName: string): void {
  sink?.(commandName);
}
