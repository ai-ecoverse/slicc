/**
 * Tests for the Wave B5 panel-VFS guard. Asserts the warning fires when
 * the side panel would construct a `VirtualFS` while
 * `slicc_opfs_vfs === 'opfs'` (offscreen-owns-OPFS regime), and stays
 * silent on the legacy LFS path so existing extension boots are
 * unaffected.
 */

import { describe, expect, it, vi } from 'vitest';
import { warnIfPanelVfsConstructionUnderOpfs } from '../../src/ui/panel-vfs-guard.js';

function makeLogger() {
  return { warn: vi.fn() };
}

describe('warnIfPanelVfsConstructionUnderOpfs (Wave B5)', () => {
  it("warns when backend is 'opfs' (offscreen must be the sole constructor)", () => {
    const logger = makeLogger();
    const fired = warnIfPanelVfsConstructionUnderOpfs('opfs', logger);
    expect(fired).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = logger.warn.mock.calls[0]!;
    expect(message).toContain('Wave B5');
    expect(message).toContain('slicc_opfs_vfs');
    expect(message).toContain('Offscreen');
  });

  it("stays silent on the legacy 'lfs' backend", () => {
    const logger = makeLogger();
    const fired = warnIfPanelVfsConstructionUnderOpfs('lfs', logger);
    expect(fired).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
