/**
 * A command that settles the moment its signal aborts.
 *
 * just-bash gives an aborted command 100 ms (`maxExtensionCleanupTimeMs`) to
 * settle; one that is still running after that poisons the execution scope,
 * and every later `exec` in it fails with "bash: execution aborted". A nested
 * `ctx.exec` shares its caller's scope, so one slow command poisons a
 * long-lived caller for good: ^C on `mount` waiting at its prompt, typed in
 * GNU bash on the panel terminal, left every later just-bash command in that
 * session aborting (#3530).
 *
 * The abort already revokes the command's context, so settling early takes
 * nothing from it: whatever it still does in the background, it does without
 * the shell. Its own abort listeners (a realm's worker kill, say) still run.
 */
import type { Command } from 'just-bash';

type CommandExecResult = Awaited<ReturnType<Command['execute']>>;

/** What an aborted command reports; just-bash reports its own abort over it. */
const ABORTED: CommandExecResult = { stdout: '', stderr: '', exitCode: 130 };

export function settleOnAbort(
  run: () => Promise<CommandExecResult>,
  signal: AbortSignal | undefined
): Promise<CommandExecResult> {
  if (!signal) return run();
  if (signal.aborted) return Promise.resolve(ABORTED);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<CommandExecResult>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([run(), aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}
