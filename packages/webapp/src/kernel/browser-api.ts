/**
 * Re-export the CDP automation class type for shell supplemental commands.
 * Kernel sits outside the documented layer stack, so shell can import this
 * without a shell → cdp back-edge (`docs/review-patterns.md` § Layer-stack).
 */
export type { BrowserAPI } from '../cdp/browser-api.js';
