/**
 * Vitest setup file — minimal CloseEvent polyfill for the Node test environment.
 *
 * Node 22 (the mission runtime) does not expose `CloseEvent` as a global;
 * it became available in Node 23. Several WebSocket mock classes in the
 * webapp test suite construct `new CloseEvent(...)` inside `setTimeout`
 * callbacks. Without this polyfill those throw uncaught async
 * ReferenceErrors that pollute the shared vitest worker pool and turn
 * otherwise-green sibling files red in the full run.
 */
if (typeof globalThis.CloseEvent === 'undefined') {
  class CloseEventPolyfill extends Event {
    code: number;
    reason: string;
    wasClean: boolean;

    constructor(type: string, eventInitDict?: CloseEventInit) {
      super(type, eventInitDict);
      this.code = eventInitDict?.code ?? 0;
      this.reason = eventInitDict?.reason ?? '';
      this.wasClean = eventInitDict?.wasClean ?? false;
    }
  }

  Object.defineProperty(globalThis, 'CloseEvent', {
    value: CloseEventPolyfill,
    writable: true,
    configurable: true,
  });
}
