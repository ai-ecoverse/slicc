/**
 * Compatibility shim: the logger now lives in the foundational `base/` layer
 * (`base/logger.ts`) so lower layers (fs/, shell/, tools/) can depend on it
 * without an up-the-stack back-edge into `core/`. A handful of pre-existing
 * multi-back-edge modules still import `createLogger` from this path; this
 * re-export keeps them working. New code should import from `base/logger.js`.
 */

export { createLogger } from '../base/logger.js';
