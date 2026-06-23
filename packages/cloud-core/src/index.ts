// Public re-exports for the @slicc/cloud-core package.
// Populated by subsequent tasks as we move code in.

// Re-export the side-effect-free cone-config contract from the root too, so
// Node/worker consumers (which go through node-server's inline-workspaces
// packaging that only rewrites the bare '@slicc/cloud-core' specifier) can
// import it from the root. The browser webapp must still import the
// './cone-config' subpath to avoid pulling e2b into its bundle.
export * from './cone-config/index.js';
export * from './errors.js';
export type { KillConeDeps, KillConeResult } from './operations/kill.js';
export { killCone } from './operations/kill.js';
export type { ListConesDeps, ListConesOpts } from './operations/list.js';
export { listCones } from './operations/list.js';
export type { PauseConeDeps } from './operations/pause.js';
export { pauseCone } from './operations/pause.js';
export type { ResumeConeDeps, ResumeConeOpts } from './operations/resume.js';
export { resumeCone } from './operations/resume.js';
export type { ReserveSlotOpts, StartConeDeps, StartConeOpts } from './operations/start.js';
export { reserveSlot, startCone } from './operations/start.js';
export * from './polling.js';
export type { Registry } from './registry.js';
export { filterSecretsEnv } from './secrets-filter.js';
export * from './substrate.js';
export * from './substrate-factory.js';
export { createE2bSubstrate, isSliccTemplate } from './substrates/e2b.js';
export * from './types.js';
