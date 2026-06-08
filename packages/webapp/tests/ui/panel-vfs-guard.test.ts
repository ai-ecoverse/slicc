/**
 * Tests for the panel-VFS guard. Asserts the warning fires when the
 * side panel would construct an OPFS-backed `VirtualFS` (offscreen-
 * owns-OPFS regime), and stays silent on the non-OPFS (`'memory'`)
 * backend used in Node test envs / fallback.
 */

import { describe, expect, it, vi } from 'vitest';
import { warnIfPanelVfsConstructionUnderOpfs } from '../../src/ui/panel-vfs-guard.js';

function makeLogger() {
  return { warn: vi.fn() };
}

describe('warnIfPanelVfsConstructionUnderOpfs', () => {
  it("warns when backend is 'opfs' (offscreen must be the sole constructor)", () => {
    const logger = makeLogger();
    const fired = warnIfPanelVfsConstructionUnderOpfs('opfs', logger);
    expect(fired).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = logger.warn.mock.calls[0]!;
    expect(message).toContain('Side panel attempted VirtualFS.create');
    expect(message).toContain('OPFS-backed');
    expect(message).toContain('Offscreen');
  });

  it("stays silent on the non-OPFS 'memory' backend", () => {
    const logger = makeLogger();
    const fired = warnIfPanelVfsConstructionUnderOpfs('memory', logger);
    expect(fired).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
