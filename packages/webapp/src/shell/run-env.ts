export const RUN_PID_ENV = '__SLICC_RUN_PID';

export const OUTPUT_TEE_ENV = '__SLICC_OUTPUT_TEE__';

export function runPidFromEnv(runEnv?: ReadonlyMap<string, string>): number | undefined {
  const raw = runEnv?.get(RUN_PID_ENV);
  if (raw === undefined) return undefined;
  const pid = Number.parseInt(raw, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
