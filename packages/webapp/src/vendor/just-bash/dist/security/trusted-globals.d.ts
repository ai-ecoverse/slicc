/**
 * SECURITY: Pre-captured references to dangerous globals.
 *
 * These are captured at module load time (before defense-in-depth patches)
 * so that just-bash infrastructure can use them. They bypass all defense
 * protections.
 *
 * DO NOT import these from command implementations unless absolutely
 * necessary (e.g., Python WASM worker IPC). Any import from this module
 * should be reviewed for security implications.
 */
export declare const _SharedArrayBuffer: typeof globalThis.SharedArrayBuffer;
export declare const _Atomics: typeof globalThis.Atomics;
export declare const _performanceNow: () => number;
export declare const _Headers: typeof globalThis.Headers;
