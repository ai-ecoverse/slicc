import { describe, expect, it } from 'vitest';
import { TrayTargetRegistry } from './tray-target-registry.js';
import type { RemoteTargetInfo } from './tray-sync-protocol.js';

describe('TrayTargetRegistry', () => {
  it('returns entries with correct targetId format for one runtime', () => {
    const reg = new TrayTargetRegistry();
    const targets: RemoteTargetInfo[] = [
      { targetId: 'tab1', title: 'Google', url: 'https://google.com' },
      { targetId: 'tab2', title: 'GitHub', url: 'https://github.com' },
    ];
    reg.setTargets('rt-A', targets);

    const entries = reg.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      targetId: 'rt-A:tab1',
      localTargetId: 'tab1',
      runtimeId: 'rt-A',
      title: 'Google',
      url: 'https://google.com',
      isLocal: false,
    });
    expect(entries[1]).toEqual({
      targetId: 'rt-A:tab2',
      localTargetId: 'tab2',
      runtimeId: 'rt-A',
      title: 'GitHub',
      url: 'https://github.com',
      isLocal: false,
    });
  });

  it('replaces targets when setTargets is called twice for the same runtime', () => {
    const reg = new TrayTargetRegistry();
    reg.setTargets('rt-A', [{ targetId: 'old', title: 'Old', url: 'http://old' }]);
    reg.setTargets('rt-A', [{ targetId: 'new', title: 'New', url: 'http://new' }]);

    const entries = reg.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].localTargetId).toBe('new');
  });

  it('merges targets from multiple runtimes', () => {
    const reg = new TrayTargetRegistry();
    reg.setTargets('rt-A', [{ targetId: 't1', title: 'A1', url: 'http://a1' }]);
    reg.setTargets('rt-B', [{ targetId: 't1', title: 'B1', url: 'http://b1' }]);

    const entries = reg.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.targetId)).toEqual(['rt-A:t1', 'rt-B:t1']);
  });

  it('removes targets when a runtime is removed', () => {
    const reg = new TrayTargetRegistry();
    reg.setTargets('rt-A', [{ targetId: 't1', title: 'A1', url: 'http://a1' }]);
    reg.setTargets('rt-B', [{ targetId: 't2', title: 'B1', url: 'http://b1' }]);

    reg.removeRuntime('rt-A');
    const entries = reg.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].runtimeId).toBe('rt-B');
  });

  it('hasChanged returns true after setTargets, false after getEntries', () => {
    const reg = new TrayTargetRegistry();
    expect(reg.hasChanged()).toBe(false);

    reg.setTargets('rt-A', [{ targetId: 't1', title: 'A', url: 'http://a' }]);
    expect(reg.hasChanged()).toBe(true);

    reg.getEntries();
    expect(reg.hasChanged()).toBe(false);
  });

  it('hasChanged returns true after removeRuntime', () => {
    const reg = new TrayTargetRegistry();
    reg.setTargets('rt-A', [{ targetId: 't1', title: 'A', url: 'http://a' }]);
    reg.getEntries(); // reset dirty flag

    reg.removeRuntime('rt-A');
    expect(reg.hasChanged()).toBe(true);
  });

  it('returns empty array for empty registry', () => {
    const reg = new TrayTargetRegistry();
    expect(reg.getEntries()).toEqual([]);
  });

  it('getRuntimeIds returns correct set', () => {
    const reg = new TrayTargetRegistry();
    expect(reg.getRuntimeIds()).toEqual([]);

    reg.setTargets('rt-A', []);
    reg.setTargets('rt-B', []);
    expect(reg.getRuntimeIds().sort()).toEqual(['rt-A', 'rt-B']);

    reg.removeRuntime('rt-A');
    expect(reg.getRuntimeIds()).toEqual(['rt-B']);
  });

  it('removeRuntime on unknown id is a no-op and does not set dirty', () => {
    const reg = new TrayTargetRegistry();
    reg.getEntries(); // reset
    reg.removeRuntime('nonexistent');
    expect(reg.hasChanged()).toBe(false);
  });
});
