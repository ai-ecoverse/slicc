import { describe, expect, it } from 'vitest';

import {
  createElectronOverlayShellState,
  normalizeElectronOverlayLauncherCorner,
  resolveElectronOverlayLauncherCorner,
  setElectronOverlayCorner,
  setElectronOverlayOpen,
  setElectronOverlayTab,
  shouldSnapElectronOverlayLauncher,
  toggleElectronOverlay,
} from './overlay-shell-state.js';

describe('overlay-shell-state', () => {
  it('creates a closed shell with the chat tab by default', () => {
    expect(createElectronOverlayShellState()).toEqual({
      open: false,
      activeTab: 'chat',
      corner: 'top-right',
    });
  });

  it('toggles the overlay open state', () => {
    const state = createElectronOverlayShellState();
    expect(toggleElectronOverlay(state)).toEqual({
      open: true,
      activeTab: 'chat',
      corner: 'top-right',
    });
  });

  it('preserves object identity when the open state does not change', () => {
    const state = createElectronOverlayShellState({ open: true, activeTab: 'files' });
    expect(setElectronOverlayOpen(state, true)).toBe(state);
  });

  it('normalizes unsupported tabs to the current tab', () => {
    const state = createElectronOverlayShellState({ activeTab: 'terminal' });
    expect(setElectronOverlayTab(state, 'unknown')).toBe(state);
  });

  it('changes the active tab when a supported tab is selected', () => {
    const state = createElectronOverlayShellState();
    expect(setElectronOverlayTab(state, 'memory')).toEqual({
      open: false,
      activeTab: 'memory',
      corner: 'top-right',
    });
  });

  it('normalizes unsupported launcher corners to the fallback', () => {
    expect(normalizeElectronOverlayLauncherCorner('middle', 'bottom-left')).toBe('bottom-left');
  });

  it('changes the launcher corner when a supported corner is selected', () => {
    const state = createElectronOverlayShellState();
    expect(setElectronOverlayCorner(state, 'bottom-left')).toEqual({
      open: false,
      activeTab: 'chat',
      corner: 'bottom-left',
    });
  });

  it('treats longer drags as a snap gesture', () => {
    expect(shouldSnapElectronOverlayLauncher(8, 0.2)).toBe(true);
  });

  it('treats fast short flicks as a snap gesture', () => {
    expect(shouldSnapElectronOverlayLauncher(14, 0.9)).toBe(true);
    expect(shouldSnapElectronOverlayLauncher(4, 0.9)).toBe(false);
  });

  it('projects flick velocity when resolving the snap corner', () => {
    expect(
      resolveElectronOverlayLauncherCorner({
        clientX: 440,
        clientY: 320,
        viewportWidth: 1000,
        viewportHeight: 800,
        velocityXPxPerMs: 1,
        velocityYPxPerMs: 1,
      }),
    ).toBe('bottom-right');
  });
});