/**
 * Capture bash PIPESTATUS for the agent bash tool without changing last-stage
 * exit semantics.
 *
 * just-bash isolates interpreter state per `exec()`, so PIPESTATUS is gone
 * when the call returns. The wrapper records it into env vars in the same
 * script, then the shell strips those keys before they reach `lastEnv`.
 */

/** Env var holding `${PIPESTATUS[*]}` from the wrapped command. */
export const PIPESTATUS_ENV = '__SLICC_PIPESTATUS';

/** Env var holding `$?` from the wrapped command (last-stage / pipefail). */
export const PIPESTATUS_EXIT_ENV = '__SLICC_PIPESTATUS_EX';

const EXIT_CODE_RE = /^(0|[1-9]\d*)$/;

/**
 * Run `command` in the current shell, then record PIPESTATUS and `$?`.
 *
 * The group keeps assignments and functions from the command in this shell.
 * The trailing assignment is one simple command so both expansions still see
 * the command's PIPESTATUS / `$?` (a second command would overwrite them).
 * The script's own exit becomes 0 from that assignment; the caller restores
 * the captured `$?`.
 */
export function wrapCommandForPipeStatus(command: string): string {
  const body = command.trimEnd();
  if (!body) return command;
  return `{
${body}
}
${PIPESTATUS_EXIT_ENV}=$? ${PIPESTATUS_ENV}="\${PIPESTATUS[*]}"`;
}

/** Parse a `PIPESTATUS[*]` string into integer exit codes; `[]` if malformed. */
export function parsePipeStatus(raw: string | undefined): number[] {
  if (!raw) return [];
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  const codes: number[] = [];
  for (const part of parts) {
    if (!EXIT_CODE_RE.test(part)) return [];
    const n = Number(part);
    if (n > 255) return [];
    codes.push(n);
  }
  return codes;
}

export interface CapturedPipeStatus {
  pipeStatus: number[];
  exitCode: number | undefined;
}

/** Script text actually handed to `bash.exec` when capture is requested. */
export function scriptForPipeStatusCapture(command: string, capture: boolean): string {
  if (!capture) return command;
  return wrapCommandForPipeStatus(command);
}

/**
 * Restore last-stage `$?` from the capture trailer and attach `pipeStatus`.
 * No-op when capture was off or the trailer did not run.
 */
export function applyCapturedPipeStatus<
  T extends { env?: Record<string, string>; exitCode: number },
>(result: T, capture: boolean): T & { pipeStatus?: number[] } {
  if (!capture || !result.env) return result;
  const captured = takePipeStatusFromEnv(result.env);
  const next =
    captured.exitCode === undefined ? result : { ...result, exitCode: captured.exitCode };
  if (captured.pipeStatus.length === 0) return next;
  return { ...next, pipeStatus: captured.pipeStatus };
}

export function attachPipeStatus<T extends object>(
  result: T,
  pipeStatus: number[] | undefined
): T & { pipeStatus?: number[] } {
  if (pipeStatus === undefined) return result;
  return { ...result, pipeStatus };
}

/**
 * Pull the capture vars off `env` (mutates) so they never persist as shell
 * state. `exitCode` is undefined when the trailer did not run (errexit, `exit`).
 */
export function takePipeStatusFromEnv(env: Record<string, string>): CapturedPipeStatus {
  const raw = env[PIPESTATUS_ENV];
  const exRaw = env[PIPESTATUS_EXIT_ENV];
  delete env[PIPESTATUS_ENV];
  delete env[PIPESTATUS_EXIT_ENV];
  let exitCode: number | undefined;
  if (exRaw !== undefined && EXIT_CODE_RE.test(exRaw)) {
    const n = Number(exRaw);
    if (n <= 255) exitCode = n;
  }
  return { pipeStatus: parsePipeStatus(raw), exitCode };
}

/**
 * Annotation for a mixed-or-failed pipeline. `null` when there is no pipeline,
 * every stage succeeded, or the codes are unusable.
 */
export function formatPipelineStatus(codes: readonly number[]): string | null {
  if (codes.length < 2) return null;
  if (codes.every((code) => code === 0)) return null;
  if (!codes.every((code) => Number.isInteger(code) && code >= 0 && code <= 255)) {
    return null;
  }
  return `pipeline: ${codes.join(' ')}`;
}

/** Append a pipeline-status line so it survives tail truncation of `output`. */
export function appendPipelineStatus(output: string, codes: readonly number[] | undefined): string {
  const line = codes ? formatPipelineStatus(codes) : null;
  if (!line) return output;
  if (!output) return line;
  return output.endsWith('\n') ? `${output}${line}` : `${output}\n${line}`;
}
