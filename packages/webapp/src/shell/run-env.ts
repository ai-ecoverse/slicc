/**
 * Per-run env tags the shell stamps onto a `bash.exec` and strips before
 * writing the snapshot back. Concurrent runs on one shell share no mutable
 * pid/tee fields — they ride `ctx.env` instead.
 */

/**
 * Env var carrying the parent pid of the run a command belongs to.
 *
 * Realm-backed commands (`node` / `python` / `.jsh`) register their realm child
 * under it, so `kill <job pid>` reaches that child and only that child. Reading
 * it from the command's OWN `ctx.env` is what makes parentage exact while
 * several detached runs share one shell. Internal: stripped from the env
 * written back onto the shell, so it never outlives its run.
 */
export const RUN_PID_ENV = '__SLICC_RUN_PID';

/**
 * Env var demuxing an incremental output tee across concurrent `executeCommand`
 * runs on one shell (#2415). Same channel as {@link RUN_PID_ENV}: just-bash
 * still passes `env` through per-exec, and a nested exec inherits it. Stripped
 * from the env written back onto the shell so it never outlives its run.
 */
export const OUTPUT_TEE_ENV = '__SLICC_OUTPUT_TEE__';

/** Read the run's parent pid back out of a command's environment. */
export function runPidFromEnv(runEnv?: ReadonlyMap<string, string>): number | undefined {
  const raw = runEnv?.get(RUN_PID_ENV);
  if (raw === undefined) return undefined;
  const pid = Number.parseInt(raw, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
