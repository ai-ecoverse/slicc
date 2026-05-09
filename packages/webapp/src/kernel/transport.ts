/**
 * `KernelTransport` — the wire under the kernel facade.
 *
 * Kept as a leaf module: zero imports, pure types. This is what
 * `tsconfig.webapp-worker.json` typechecks against, so the worker-side
 * code can `import type { KernelTransport } from './transport.js'`
 * without dragging in `Orchestrator`, `BrowserAPI`, `VirtualFS`, or any
 * of the DOM-using webapp graph that `./types.js` references.
 *
 * `./types.js` re-exports `KernelTransport` so the rest of the codebase
 * keeps using a single import path.
 */

/**
 * Phase 1 keeps today's `chrome.runtime` envelope on the wire; Phase 2
 * adds a `MessageChannel` adapter. Both implementations fulfil this
 * interface.
 *
 * `In` / `Out` are the existing message types; they are NOT renamed.
 * That keeps Phase 1 a pure refactor — the bytes on the wire don't
 * change, only the call paths around them.
 */
export interface KernelTransport<In, Out> {
  /** Subscribe to inbound messages. Returns an unsubscribe function. */
  onMessage(handler: (message: In) => void): () => void;

  /** Send an outbound message. Fire-and-forget; transports queue or drop. */
  send(message: Out): void;
}
