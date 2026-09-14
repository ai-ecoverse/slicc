import { afterEach, describe, expect, it } from 'vitest';
import { define } from '../../src/internal/define.js';

class FooElement extends HTMLElement {}
class BarElement extends HTMLElement {}

describe('define()', () => {
  const realDescriptor = Object.getOwnPropertyDescriptor(window, 'customElements');

  afterEach(() => {
    if (realDescriptor) Object.defineProperty(window, 'customElements', realDescriptor);
  });

  it('registers an element with the page registry', () => {
    const tag = `test-define-foo-${Math.random().toString(36).slice(2, 10)}`;
    define(tag, FooElement);
    expect(customElements.get(tag)).toBe(FooElement);
  });

  it('is idempotent on double-registration', () => {
    const tag = `test-define-bar-${Math.random().toString(36).slice(2, 10)}`;
    define(tag, BarElement);
    expect(() => define(tag, BarElement)).not.toThrow();
    expect(() => define(tag, FooElement)).not.toThrow();
    expect(customElements.get(tag)).toBe(BarElement);
  });

  it('no-ops when customElements is null (MV3 ISOLATED-world quirk)', () => {
    Object.defineProperty(window, 'customElements', { value: null, configurable: true });
    expect(() => define('test-define-null', FooElement)).not.toThrow();
  });

  it('no-ops when customElements is undefined', () => {
    Object.defineProperty(window, 'customElements', { value: undefined, configurable: true });
    expect(() => define('test-define-undef', FooElement)).not.toThrow();
  });
});
