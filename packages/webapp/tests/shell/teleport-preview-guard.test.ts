import { describe, expect, it } from 'vitest';
import type { BrowserAPI } from '../../src/cdp/browser-api.js';
import type { PlaywrightState } from '../../src/shell/supplemental-commands/playwright/playwright-state.js';
import { armTeleportWatcher } from '../../src/shell/supplemental-commands/playwright/teleport.js';

function stubBrowser(): BrowserAPI {
  return {} as BrowserAPI;
}

function stubState(): PlaywrightState {
  return {
    currentPage: null,
    currentTargetId: null,
    sessions: new Map(),
  } as PlaywrightState;
}

describe('armTeleportWatcher preview guard', () => {
  it('refuses to arm teleport against the preview runtime', () => {
    expect(() =>
      armTeleportWatcher(
        stubBrowser(),
        stubState(),
        /start/,
        /return/,
        30000,
        'preview' // explicit runtime ID
      )
    ).toThrow(/cannot teleport/i);
  });
});
