import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXTENSION_TAB_ID,
  EXTENSION_TAB_SPECS,
  isExtensionTabId,
  normalizeExtensionTabId,
} from './tabbed-ui.js';

describe('tabbed-ui', () => {
  it('keeps the extension and overlay tab order in one shared place', () => {
    expect(EXTENSION_TAB_SPECS.map(tab => tab.id)).toEqual([
      'chat',
      'terminal',
      'files',
      'memory',
    ]);
  });

  it('recognizes supported tab ids', () => {
    expect(isExtensionTabId('chat')).toBe(true);
    expect(isExtensionTabId('memory')).toBe(true);
    expect(isExtensionTabId('settings')).toBe(false);
  });

  it('normalizes unknown tab ids back to the default', () => {
    expect(normalizeExtensionTabId('nope')).toBe(DEFAULT_EXTENSION_TAB_ID);
    expect(normalizeExtensionTabId(undefined)).toBe(DEFAULT_EXTENSION_TAB_ID);
    expect(normalizeExtensionTabId(null, 'files')).toBe('files');
  });
});