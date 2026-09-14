export const SILENT_RENEW_TIMEOUT_MS = 10_000;

export function buildWebAuthFlowOptions(url: string, interactive: boolean) {
  if (interactive) {
    return { url, interactive: true as const };
  }
  return {
    url,
    interactive: false as const,
    abortOnLoadForNonInteractive: false,
    timeoutMsForNonInteractive: SILENT_RENEW_TIMEOUT_MS,
  };
}
