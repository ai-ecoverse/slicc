import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Mock localStorage
const storage = new Map<string, string>();
const mockStorage = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    storage.delete(key);
  }),
  clear: vi.fn(() => storage.clear()),
  get length() {
    return storage.size;
  },
  key: vi.fn((_i: number) => null),
};
vi.stubGlobal('localStorage', mockStorage);

// Mock document.documentElement.classList
const classList = new Set<string>();
const mockClassList = {
  add: vi.fn((cls: string) => classList.add(cls)),
  remove: vi.fn((cls: string) => classList.delete(cls)),
  toggle: vi.fn((cls: string, force?: boolean) => {
    if (force === undefined) {
      if (classList.has(cls)) {
        classList.delete(cls);
      } else {
        classList.add(cls);
      }
    } else if (force) {
      classList.add(cls);
    } else {
      classList.delete(cls);
    }
  }),
  contains: vi.fn((cls: string) => classList.has(cls)),
};
vi.stubGlobal('document', { documentElement: { classList: mockClassList } });

// Mock window.matchMedia
const mockMatchMedia = vi.fn(() => ({
  matches: false,
  addEventListener: vi.fn(),
}));
vi.stubGlobal('window', { matchMedia: mockMatchMedia });

afterAll(() => {
  vi.unstubAllGlobals();
});

import { getThemePreference, setThemePreference, applyTheme, initTheme } from '../../src/ui/theme.js';

describe('theme', () => {
  beforeEach(() => {
    storage.clear();
    classList.clear();
    vi.clearAllMocks();
  });

  describe('getThemePreference', () => {
    it('defaults to light when nothing stored', () => {
      expect(getThemePreference()).toBe('light');
    });

    it('returns stored preference', () => {
      storage.set('slicc-theme', 'dark');
      expect(getThemePreference()).toBe('dark');
    });

    it('returns light for invalid stored value', () => {
      storage.set('slicc-theme', 'invalid');
      expect(getThemePreference()).toBe('light');
    });
  });

  describe('setThemePreference', () => {
    it('stores preference and applies theme', () => {
      setThemePreference('light');
      expect(mockStorage.setItem).toHaveBeenCalledWith('slicc-theme', 'light');
      expect(storage.get('slicc-theme')).toBe('light');
    });

    it('applies theme-light class for light preference', () => {
      setThemePreference('light');
      expect(classList.has('theme-light')).toBe(true);
    });

    it('removes theme-light class for dark preference', () => {
      classList.add('theme-light');
      setThemePreference('dark');
      expect(classList.has('theme-light')).toBe(false);
    });
  });

  describe('applyTheme', () => {
    it('adds theme-light when preference is light', () => {
      storage.set('slicc-theme', 'light');
      applyTheme();
      expect(classList.has('theme-light')).toBe(true);
    });

    it('removes theme-light when preference is dark', () => {
      classList.add('theme-light');
      storage.set('slicc-theme', 'dark');
      applyTheme();
      expect(classList.has('theme-light')).toBe(false);
    });

    it('respects matchMedia for system preference', () => {
      storage.set('slicc-theme', 'system');
      applyTheme();
      // mockMatchMedia returns matches: false
      expect(classList.has('theme-light')).toBe(false);
    });
  });

  describe('initTheme', () => {
    it('applies theme on init', () => {
      storage.set('slicc-theme', 'light');
      initTheme();
      expect(classList.has('theme-light')).toBe(true);
    });
  });
});
