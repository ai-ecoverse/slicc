import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSprinkleRoute,
  getAllSprinkleRoutes,
  getSprinkleRoute,
  setSprinkleRoute,
} from '../../src/shell/sprinkle-routes.js';

describe('sprinkle route helpers', () => {
  let store: Record<string, string>;
  const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;

  beforeEach(() => {
    store = {};
    const polyfill: Storage = {
      get length() {
        return Object.keys(store).length;
      },
      clear: () => {
        store = {};
      },
      getItem: (key: string) => (key in store ? store[key] : null),
      key: (index: number) => Object.keys(store)[index] ?? null,
      removeItem: (key: string) => {
        delete store[key];
      },
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: polyfill,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
        writable: true,
      });
    }
  });

  it('returns undefined when no route is set', () => {
    expect(getSprinkleRoute('foo')).toBeUndefined();
    expect(getAllSprinkleRoutes()).toEqual({});
  });

  it('persists set and clears a route through localStorage', () => {
    setSprinkleRoute('foo', 'scoop-a');
    expect(getSprinkleRoute('foo')).toBe('scoop-a');
    expect(getAllSprinkleRoutes()).toEqual({ foo: 'scoop-a' });
    // Reuses the existing store on subsequent set, preserving siblings.
    setSprinkleRoute('bar', 'scoop-b');
    expect(getAllSprinkleRoutes()).toEqual({ foo: 'scoop-a', bar: 'scoop-b' });

    clearSprinkleRoute('foo');
    expect(getSprinkleRoute('foo')).toBeUndefined();
    expect(getAllSprinkleRoutes()).toEqual({ bar: 'scoop-b' });
  });

  it('treats corrupted localStorage payloads as empty', () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      'slicc-sprinkle-routes',
      '{not json'
    );
    expect(getAllSprinkleRoutes()).toEqual({});
  });

  it('silently swallows setItem failures (quota etc.)', () => {
    const ls = (globalThis as { localStorage: Storage }).localStorage;
    ls.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    expect(() => setSprinkleRoute('foo', 'scoop-a')).not.toThrow();
  });
});
