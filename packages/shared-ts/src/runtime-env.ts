export function isChromeExtensionRealm(): boolean {
  const runtimeId = (globalThis as { chrome?: { runtime?: { id?: unknown } } }).chrome?.runtime?.id;
  return typeof runtimeId === 'string' && runtimeId.length > 0;
}

export function canConnectToChromeRuntime(): boolean {
  const runtime = (globalThis as { chrome?: { runtime?: { connect?: unknown } } }).chrome?.runtime;
  return typeof runtime?.connect === 'function';
}
