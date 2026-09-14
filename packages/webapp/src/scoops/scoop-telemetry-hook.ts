export type ScoopLifecycleEvent = 'spawn' | 'feed' | 'complete' | 'error';

type ScoopTelemetrySink = (
  event: ScoopLifecycleEvent,
  scoopName: string,
  details?: unknown
) => void;

let sink: ScoopTelemetrySink | null = null;

export function setScoopTelemetrySink(fn: ScoopTelemetrySink | null): void {
  sink = fn;
}

export function emitScoopLifecycle(
  event: ScoopLifecycleEvent,
  scoopName: string,
  details?: unknown
): void {
  sink?.(event, scoopName, details);
}
