/**
 * Buffer polyfill for browser environment.
 * Required by isomorphic-git for binary data operations.
 */

import { Buffer } from 'buffer';

// Make Buffer available globally for isomorphic-git
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}

export { Buffer };
