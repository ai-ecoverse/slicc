/**
 * Type declaration for the worker-safe inlined Helix RUM beacon sampler.
 * The implementation lives in rum-worker.js (intentionally JavaScript — a
 * worker-globals mirror of rum.js). This file gives TypeScript a
 * default-export signature for callers like telemetry.ts.
 */
declare const sampleRUM: (checkpoint: string, data?: { source?: string; target?: string }) => void;
export default sampleRUM;
