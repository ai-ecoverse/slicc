import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTENSION_TAB_ID,
  EXTENSION_TAB_SPECS,
  isBuiltinExtensionTabId,
  isExtensionTabId,
  normalizeExtensionTabId,
} from '../../src/ui/tabbed-ui.js';

describe('tabbed-ui', () => {
  it('keeps the extension and overlay tab order in one shared place', () => {
    expect(EXTENSION_TAB_SPECS.map((tab) => tab.id)).toEqual([
      'chat',
      'terminal',
      'files',
      'memory',
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
