/**
 * Type declaration for the inlined Helix RUM beacon sampler.
 * The implementation lives in rum.js (intentionally JavaScript — verbatim port
 * of @adobe/aem-sidekick's pattern). This file gives TypeScript a default-export
 * signature for callers like telemetry.ts.
 */
declare const sampleRUM: (checkpoint: string, data?: { source?: string; target?: string }) => void;
export default sampleRUM;
