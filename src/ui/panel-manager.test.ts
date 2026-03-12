import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VirtualFS } from '../fs/virtual-fs.js';
import { PanelManager } from './panel-manager.js';
import type { LickEvent } from '../scoops/lick-manager.js';

describe('PanelManager', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;
  let lickHandler: (event: LickEvent) => void;
  let addPanel: ReturnType<typeof vi.fn>;
  let removePanel: ReturnType<typeof vi.fn>;
  let mgr: PanelManager;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-panel-manager-${dbCounter++}`,
      wipe: true,
    });
    lickHandler = vi.fn() as unknown as (event: LickEvent) => void;
    addPanel = vi.fn();
    removePanel = vi.fn();
    mgr = new PanelManager(vfs, lickHandler, {
      addPanel: addPanel as unknown as (name: string, title: string, element: HTMLElement) => void,
      removePanel: removePanel as unknown as (name: string) => void,
    });
  });

  it('refresh discovers available panels', async () => {
    await vfs.writeFile('/workspace/skills/dash/dash.shtml', '<title>Dashboard</title><div>hi</div>');
    await mgr.refresh();
    const panels = mgr.available();
    expect(panels.length).toBe(1);
    expect(panels[0].name).toBe('dash');
    expect(panels[0].title).toBe('Dashboard');
  });

  it('available() returns empty when no panels', async () => {
    await mgr.refresh();
    expect(mgr.available()).toEqual([]);
  });

  it('opened() returns empty initially', () => {
    expect(mgr.opened()).toEqual([]);
  });

  it('open throws for unknown panel', async () => {
    await expect(mgr.open('nonexistent')).rejects.toThrow('Panel not found: nonexistent');
  });

  it('sendToPanel does not throw for closed panel', () => {
    expect(() => mgr.sendToPanel('unknown', {})).not.toThrow();
  });
});
