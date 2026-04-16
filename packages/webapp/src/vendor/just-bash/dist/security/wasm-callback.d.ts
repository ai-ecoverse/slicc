export declare function sanitizeUnknownError(error: unknown): string;
/**
 * Wrap WASM-to-JS callbacks so callback failures are surfaced as sanitized
 * internal errors without leaking host/internal paths.
 */
export declare function wrapWasmCallback<TArgs extends unknown[], TResult>(component: string, phase: string, callback: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
