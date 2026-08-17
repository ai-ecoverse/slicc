/** True when running inside a Chrome extension realm. */
export function isChromeExtensionRealm(): boolean {
  const runtimeId = (globalThis as { chrome?: { runtime?: { id?: unknown } } }).chrome?.runtime?.id;
  return typeof runtimeId === 'string' && runtimeId.length > 0;
}

/** True when this page can open a named port to a Chrome extension. */
export function canConnectToChromeRuntime(): boolean {
  const runtime = (globalThis as { chrome?: { runtime?: { connect?: unknown } } }).chrome?.runtime;
  return typeof runtime?.connect === 'function';
}
