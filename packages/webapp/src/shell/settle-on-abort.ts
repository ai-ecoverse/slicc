import type { Command } from 'just-bash';

type CommandExecResult = Awaited<ReturnType<Command['execute']>>;

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
