import type { Process, ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';

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
