// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { requestPlacedSurfaceFullscreen } from '../../../src/ui/wc/surface-fullscreen.js';

describe('requestPlacedSurfaceFullscreen', () => {
  it('requests fullscreen on a placed surface', () => {
    const root = document.createElement('div');
    const surface = document.createElement('div');
    surface.setAttribute('surface-id', 'files');
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.assign(surface, { requestFullscreen });
    root.appendChild(surface);

    expect(requestPlacedSurfaceFullscreen(root, 'files')).toBe(true);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('escapes colon-bearing sprinkle ids in the attribute selector', () => {
    const root = document.createElement('div');
    const surface = document.createElement('div');
    surface.setAttribute('surface-id', 'sprinkle:notes');
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.assign(surface, { requestFullscreen });
    root.appendChild(surface);

    expect(requestPlacedSurfaceFullscreen(root, 'sprinkle:notes')).toBe(true);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('returns false and does not request fullscreen for a parked surface', () => {
    const root = document.createElement('div');
    const parking = document.createElement('div');
    parking.className = 'dock-tree__parking';
    const surface = document.createElement('div');
    surface.setAttribute('surface-id', 'term');
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.assign(surface, { requestFullscreen });
    parking.appendChild(surface);
    root.appendChild(parking);

    expect(requestPlacedSurfaceFullscreen(root, 'term')).toBe(false);
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it('returns false when the surface is missing', () => {
    expect(requestPlacedSurfaceFullscreen(document.createElement('div'), 'memory')).toBe(false);
  });

  it('swallows a rejected requestFullscreen promise', () => {
    const root = document.createElement('div');
    const surface = document.createElement('div');
    surface.setAttribute('surface-id', 'monitor');
    Object.assign(surface, {
      requestFullscreen: vi.fn(() => Promise.reject(new Error('denied'))),
    });
    root.appendChild(surface);

    expect(() => requestPlacedSurfaceFullscreen(root, 'monitor')).not.toThrow();
  });
});
