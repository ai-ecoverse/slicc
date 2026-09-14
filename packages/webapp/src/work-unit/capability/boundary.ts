import { type CapabilityDomain, type CapabilityResult, capabilityFailed } from './types.js';

export function createLazyOps<T>(load: () => Promise<T>, timeoutMs?: number): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending === null) {
      const loaded =
        timeoutMs === undefined
          ? load()
          : withTimeout(load(), timeoutMs, (ms) => `module load exceeded ${ms}ms`);
      pending = loaded.catch((err: unknown) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: (timeoutMs: number) => string = (ms) => `no answer within ${ms}ms`
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message(timeoutMs))), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function guardCapability<T>(
  capability: CapabilityDomain,
  operation: string,
  run: () => Promise<CapabilityResult<T>>
): Promise<CapabilityResult<T>> {
  try {
    return await run();
  } catch (err) {
    return capabilityFailed(
      capability,
      operation,
      err instanceof Error ? err.message : String(err)
    );
  }
}
