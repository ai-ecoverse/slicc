/**
 * The kernel process one turn runs as.
 *
 * Owns: spawning the `kind:'scoop-turn'` record, the signal route used to
 * interrupt it, and the exit code it reports (1 on failure, `null` on abort,
 * 0 on a clean finish).
 *
 * Changes when the process model changes — what `ps` shows, what a signal
 * fans out to, how an exit code is derived. Turn CONTENT (retries, bounds,
 * recovery) is elsewhere; this is only the bookkeeping that makes a turn a
 * real, signalable pid.
 */

import type { Process, ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';

/** Longest prompt excerpt carried in the process `argv`. */
const ARGV_EXCERPT = 200;

export function spawnTurnProcess(
  processManager: ProcessManager | null,
  spec: { text: string; cwd: string; owner: ProcessOwner; abortController: AbortController }
): Process | null {
  if (!processManager) return null;

  const { text } = spec;
  const excerpt = text.length > ARGV_EXCERPT ? `${text.slice(0, ARGV_EXCERPT - 3)}…` : text;
  return processManager.spawn({
    kind: 'scoop-turn',
    argv: ['prompt', excerpt],
    cwd: spec.cwd,
    owner: spec.owner,
    adoptAbort: spec.abortController,
  });
}

/**
 * Record how the turn ended. A failure that was NOT aborted exits 1; an abort
 * exits `null` so the manager derives the code from `terminatedBy` (130 for
 * SIGINT, 143 for SIGTERM); everything else exits 0.
 */
export function finishTurnProcess(
  processManager: ProcessManager | null,
  turnProcess: Process | null,
  outcome: { lastError: Error | null; aborted: boolean }
): void {
  if (!turnProcess || !processManager) return;
  if (outcome.lastError && !outcome.aborted) {
    processManager.exit(turnProcess.pid, 1);
  } else {
    processManager.exit(turnProcess.pid, outcome.aborted ? null : 0);
  }
}

/**
 * Interrupt the running turn. Routed through `pm.signal` when there is a
 * process so the record shows `terminatedBy` before the controller aborts
 * (`signal()` calls `controller.abort()` internally — going through the
 * manager just keeps the recorded state consistent). Falls back to aborting
 * the controller directly when no manager is wired.
 */
export function signalTurnProcess(
  processManager: ProcessManager | null,
  turnProcess: Process | null,
  signal: 'SIGINT' | 'SIGTERM',
  fallback: AbortController | null
): void {
  if (turnProcess && processManager) {
    processManager.signal(turnProcess.pid, signal);
  } else {
    fallback?.abort();
  }
}
