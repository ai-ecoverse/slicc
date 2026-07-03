import { describe, expect, it } from 'vitest';
import { CHERRY_PANEL_PORT_NAME, SIDE_PANEL_FEATURES } from '../src/cherry-panel-protocol.js';

describe('cherry-panel-protocol', () => {
  it('names the internal panel port', () => {
    expect(CHERRY_PANEL_PORT_NAME).toBe('cherry-panel');
  });
  it('SIDE_PANEL_FEATURES is the chat-focused set (kernel panels off, chrome on)', () => {
    expect(SIDE_PANEL_FEATURES).toEqual({
      terminal: false,
      files: false,
      memory: false,
      browser: false,
      newSprinkle: false,
      monitor: false,
      modelPicker: true,
      history: true,
      nav: true,
    });
  });
});
