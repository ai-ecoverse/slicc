import { describe, expect, it } from 'vitest';
import * as spoon from '../src/index.js';

const PUBLIC_SURFACE = [
  'DEFAULT_LAUNCHER_CORNER',
  'DEFAULT_LAUNCHER_FOLLOWER_STATUS',
  'LAUNCHER_CORNERS',
  'LAUNCHER_FOLLOWER_STATUSES',
  'LAUNCHER_FOLLOWER_STATUS_ATTR',
  'SLICC_LAUNCHER_HOST_ID',
  'SliccLauncher',
  'define',
  'injectSliccLauncher',
  'normalizeLauncherCorner',
  'normalizeLauncherFollowerStatus',
  'removeSliccLauncher',
  'resolveLauncherCorner',
  'shouldSnapLauncher',
] as const;

describe('package barrel', () => {
  it('exports the documented public surface and nothing else', () => {
    expect(Object.keys(spoon).sort()).toEqual([...PUBLIC_SURFACE].sort());
  });

  it('registers <slicc-launcher> as an import side effect', () => {
    expect(customElements.get('slicc-launcher')).toBe(spoon.SliccLauncher);
    const el = document.createElement('slicc-launcher');
    expect(el).toBeInstanceOf(spoon.SliccLauncher);
  });

  it('keeps the overlay host id stable for the CDP injection call sites', () => {
    expect(spoon.SLICC_LAUNCHER_HOST_ID).toBe('slicc-electron-overlay-root');
  });
});
