import { describe, expect, it, vi } from 'vitest';
import { applyLayout } from '../../../src/ui/wc/apply-layout.js';
import { LAYOUT_PRESETS } from '../../../src/ui/wc/layout-spec.js';
import type { WcSprinkleZone } from '../../../src/ui/wc/wc-sprinkles.js';
import { CHAT_SURFACE_ID } from '../../../src/ui/wc/wc-sprinkles.js';

function fakeZone(): WcSprinkleZone {
  return {
    applyLayout: vi.fn(),
    moveSurfaceToZone: vi.fn(),
    placeSurface: vi.fn(),
    removeSurface: vi.fn(),
    setSurfaceSize: vi.fn(),
  } as unknown as WcSprinkleZone;
}

function zoneSpies(zone: WcSprinkleZone) {
  return zone as unknown as {
    applyLayout: ReturnType<typeof vi.fn>;
    moveSurfaceToZone: ReturnType<typeof vi.fn>;
    placeSurface: ReturnType<typeof vi.fn>;
    removeSurface: ReturnType<typeof vi.fn>;
    setSurfaceSize: ReturnType<typeof vi.fn>;
  };
}

describe('applyLayout', () => {
  it('set loads the tree into the zone', () => {
    const zone = fakeZone();
    applyLayout(zone, { kind: 'set', tree: LAYOUT_PRESETS.stage.tree });
    expect(zoneSpies(zone).applyLayout).toHaveBeenCalledWith(LAYOUT_PRESETS.stage.tree);
  });

  it('reset applies the focus preset', () => {
    const zone = fakeZone();
    applyLayout(zone, { kind: 'reset' });
    expect(zoneSpies(zone).applyLayout).toHaveBeenCalledWith(LAYOUT_PRESETS.focus.tree);
  });

  it('chat moves the chat surface to the given zone without loading a tree', () => {
    const zone = fakeZone();
    applyLayout(zone, { kind: 'chat', zone: 'right' });
    expect(zoneSpies(zone).moveSurfaceToZone).toHaveBeenCalledWith(CHAT_SURFACE_ID, 'right');
    expect(zoneSpies(zone).applyLayout).not.toHaveBeenCalled();
  });

  it('open places the surface into the given zone', () => {
    const zone = fakeZone();
    applyLayout(zone, { kind: 'open', surfaceId: 'sprinkle:weather', zone: 'left' });
    expect(zoneSpies(zone).placeSurface).toHaveBeenCalledWith('left', 'sprinkle:weather');
  });

  it('close removes the surface from the tree', () => {
    const zone = fakeZone();
    applyLayout(zone, { kind: 'close', surfaceId: 'sprinkle:weather' });
    expect(zoneSpies(zone).removeSurface).toHaveBeenCalledWith('sprinkle:weather');
  });

  it('move generalizes chat-style zone moves to any surfaceId', () => {
    const zone = fakeZone();
    applyLayout(zone, { kind: 'move', surfaceId: 'files', zone: 'bottom' });
    expect(zoneSpies(zone).moveSurfaceToZone).toHaveBeenCalledWith('files', 'bottom');
  });

  it('size forwards the surfaceId and size spec', () => {
    const zone = fakeZone();
    applyLayout(zone, {
      kind: 'size',
      surfaceId: 'sprinkle:weather',
      size: { widthPercent: 40 },
    });
    expect(zoneSpies(zone).setSurfaceSize).toHaveBeenCalledWith('sprinkle:weather', {
      widthPercent: 40,
    });
  });
});
