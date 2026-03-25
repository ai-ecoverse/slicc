// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  ELECTRON_OVERLAY_TOGGLE_SHORTCUT_CODE,
  ELECTRON_OVERLAY_TOGGLE_SHORTCUT_DISPLAY_KEY,
} from '../../src/ui/electron-overlay.js';

describe('electron-overlay-shortcut constants', () => {
  it('exports the expected shortcut code for keyboard-layout-independent matching', () => {
    expect(ELECTRON_OVERLAY_TOGGLE_SHORTCUT_CODE).toBe('Semicolon');
  });

  it('exports a display key for UI hints', () => {
    expect(ELECTRON_OVERLAY_TOGGLE_SHORTCUT_DISPLAY_KEY).toBe(';');
  });
});
