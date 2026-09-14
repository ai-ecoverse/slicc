import { validateBridgePin } from './bridge-sw.js';

export interface PortPinDeps {
  readStoredLeaderTabId: () => Promise<number | undefined>;
  writeStoredLeaderTabId: (tabId: number) => Promise<void>;
  allowedOrigins: readonly string[];
}

export type PortPinResult = { ok: true } | { ok: false; error: string };

export function beginPortPin(
  port: ChromeRuntimePort,
  deps: PortPinDeps,
  label: string
): Promise<PortPinResult> {
  const verdict = validateBridgePin(port.sender, {
    readStoredLeaderTabId: deps.readStoredLeaderTabId,
    writeStoredLeaderTabId: deps.writeStoredLeaderTabId,
    allowedOrigins: deps.allowedOrigins,
  }).then(
    (pin): PortPinResult =>
      pin.ok
        ? { ok: true }
        : { ok: false, error: `${label} pin failed: ${pin.reason ?? 'pin-failed'}` },
    (err): PortPinResult => ({
      ok: false,
      error: `${label} pin failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  );
  void verdict.then((result) => {
    if (!result.ok) console.error(`[sw] external ${label} pin check failed`, result.error);
  });
  return verdict;
}
