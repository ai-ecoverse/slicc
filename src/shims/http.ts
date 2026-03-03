/**
 * Stub for Node.js "http" module used by @smithy/node-http-handler.
 * Provides minimal named exports so Vite/Rollup can bundle without errors.
 * These are never actually invoked in the browser.
 */

export class Agent {}

export function request() {
  throw new Error('http.request is not available in the browser');
}

export function createServer() {
  throw new Error('http.createServer is not available in the browser');
}

export default { Agent, request, createServer };
