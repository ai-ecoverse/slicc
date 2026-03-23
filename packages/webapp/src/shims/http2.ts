/**
 * Stub for Node.js "http2" module used by @smithy/node-http-handler.
 * Provides minimal named exports so Vite/Rollup can bundle without errors.
 * These are never actually invoked in the browser.
 */

export const constants = {};

export function createServer() {
  throw new Error('http2.createServer is not available in the browser');
}

export function connect() {
  throw new Error('http2.connect is not available in the browser');
}

export default { constants, createServer, connect };
