/**
 * Stub for Node.js "stream" module used by @smithy/node-http-handler.
 * Provides minimal named exports so Vite/Rollup can bundle without errors.
 * These are never actually invoked in the browser.
 */

export class Readable {
  constructor() {
    throw new Error('stream.Readable is not available in the browser');
  }
}

export class Writable {
  constructor() {
    throw new Error('stream.Writable is not available in the browser');
  }
}

export default { Readable, Writable };
