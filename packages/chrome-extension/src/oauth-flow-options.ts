/**
 * Builds the options object for `chrome.identity.launchWebAuthFlow`.
 *
 * Silent renewals (prompt=none) must NOT show a window. Plain
 * `interactive:false` is insufficient for Adobe IMS: its authorize page loads
 * and then performs a JS-driven redirect, and the default non-interactive mode
 * aborts the moment that page loads ("User interaction required"). Setting
 * `abortOnLoadForNonInteractive:false` keeps the hidden web view alive across
 * the follow-up navigations until it reaches the redirect URL;
 * `timeoutMsForNonInteractive` bounds a stuck flow. (Chrome 113+.)
 */
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
