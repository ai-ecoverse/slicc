import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTENSION_TAB_ID,
  EXTENSION_TAB_SPECS,
  isBuiltinExtensionTabId,
  isExtensionTabId,
  normalizeExtensionTabId,
  setHiddenTabs,
} from './tabbed-ui.js';

describe('tabbed-ui', () => {
  it('keeps the extension and overlay tab order in one shared place', () => {
    expect(EXTENSION_TAB_SPECS.map(tab => tab.id)).toEqual([
      'chat',
      'files',
    ]);
  });

  it('recognizes built-in tab ids', () => {
    expect(isBuiltinExtensionTabId('chat')).toBe(true);
    expect(isBuiltinExtensionTabId('memory')).toBe(true);
    expect(isBuiltinExtensionTabId('settings')).toBe(false);
  });

  it('accepts any non-empty string as a valid extension tab id', () => {
    expect(isExtensionTabId('chat')).toBe(true);
    expect(isExtensionTabId('sprinkle-dashboard')).toBe(true);
    expect(isExtensionTabId('')).toBe(false);
  });

  it('normalizes empty/null tab ids to the default', () => {
    expect(normalizeExtensionTabId(undefined)).toBe(DEFAULT_EXTENSION_TAB_ID);
    expect(normalizeExtensionTabId(null)).toBe(DEFAULT_EXTENSION_TAB_ID);
    expect(normalizeExtensionTabId('')).toBe(DEFAULT_EXTENSION_TAB_ID);
  });

  it('passes through dynamic sprinkle ids unchanged', () => {
    expect(normalizeExtensionTabId('sprinkle-dash')).toBe('sprinkle-dash');
    expect(normalizeExtensionTabId('files')).toBe('files');
    expect(normalizeExtensionTabId(null, 'files')).toBe('files');
  });
});

describe('setHiddenTabs', () => {
  let store: Map<string, string>;
  let originalLocalStorage: Storage | undefined;

  beforeAll(() => {
    store = new Map<string, string>();
    originalLocalStorage = globalThis.localStorage;
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };
  });

  afterAll(() => {
    if (originalLocalStorage !== undefined) {
      (globalThis as Record<string, unknown>).localStorage = originalLocalStorage;
    }
  });

  it('stores hidden tab IDs in localStorage', () => {
    setHiddenTabs(['terminal', 'files', 'memory']);
    expect(JSON.parse(localStorage.getItem('slicc-hidden-tabs')!)).toEqual([
      'terminal', 'files', 'memory',
    ]);
  });

  it('prevents hiding chat', () => {
    setHiddenTabs(['chat', 'terminal']);
    expect(JSON.parse(localStorage.getItem('slicc-hidden-tabs')!)).toEqual(['terminal']);
  });

  afterEach(() => {
    localStorage.removeItem('slicc-hidden-tabs');
  });
});
