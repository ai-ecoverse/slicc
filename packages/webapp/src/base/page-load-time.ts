let pageLoadedAt: number | null = null;

export function setPageLoadedAt(epochMs: number | null): void {
  pageLoadedAt = epochMs !== null && Number.isFinite(epochMs) && epochMs > 0 ? epochMs : null;
}

export function readPageLoadedAt(): number {
  if (pageLoadedAt !== null) return pageLoadedAt;
  const origin = globalThis.performance?.timeOrigin;
  return typeof origin === 'number' && Number.isFinite(origin) && origin > 0 ? origin : Date.now();
}
