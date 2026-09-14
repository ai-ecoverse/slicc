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
