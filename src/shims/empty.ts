/**
 * Empty stubs for Node.js built-in modules that just-bash references
 * but aren't functional in the browser. These prevent 404 errors when
 * Vite bundles the app for the browser.
 */

// node:zlib stubs
export const constants = {};
export function gunzipSync() {
  throw new Error('gunzipSync is not available in the browser');
}
export function gzipSync() {
  throw new Error('gzipSync is not available in the browser');
}

// node:module stubs
export function createRequire() {
  throw new Error('createRequire is not available in the browser');
}

export default {};
