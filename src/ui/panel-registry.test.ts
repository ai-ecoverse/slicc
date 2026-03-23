import { describe, expect, it, vi } from 'vitest';
import { PanelRegistry } from './panel-registry.js';
import type { PanelDescriptor } from './panel-types.js';

function makeDescriptor(overrides: Partial<PanelDescriptor> = {}): PanelDescriptor {
  return {
    id: 'test-panel',
    label: 'Test',
    zone: 'primary',
    closable: false,
    element: {} as HTMLElement,
    ...overrides,
  };
}

describe('PanelRegistry', () => {
  it('registers and retrieves a panel', () => {
    const reg = new PanelRegistry();
    const desc = makeDescriptor({ id: 'terminal' });
    reg.register(desc);
    expect(reg.get('terminal')?.descriptor).toBe(desc);
    expect(reg.has('terminal')).toBe(true);
  });

  it('unregisters a panel', () => {
    const reg = new PanelRegistry();
    reg.register(makeDescriptor({ id: 'files' }));
    reg.unregister('files');
    expect(reg.has('files')).toBe(false);
    expect(reg.get('files')).toBeUndefined();
  });

  it('returns panels by zone', () => {
    const reg = new PanelRegistry();
    reg.register(makeDescriptor({ id: 'terminal', zone: 'primary' }));
    reg.register(makeDescriptor({ id: 'files', zone: 'drawer' }));
    reg.register(makeDescriptor({ id: 'memory', zone: 'drawer' }));

    expect(reg.getByZone('primary').map((d) => d.id)).toEqual(['terminal']);
    expect(reg.getByZone('drawer').map((d) => d.id)).toEqual(['files', 'memory']);
  });

  it('returns closed panels', () => {
    const reg = new PanelRegistry();
    reg.register(makeDescriptor({ id: 'terminal', zone: 'primary' }));
    reg.register(makeDescriptor({ id: 'welcome', zone: null }));

    expect(reg.getClosed().map((d) => d.id)).toEqual(['welcome']);
  });

  it('moves a panel to a different zone', () => {
    const reg = new PanelRegistry();
    reg.register(makeDescriptor({ id: 'terminal', zone: 'primary' }));
    reg.setZone('terminal', 'drawer');
    expect(reg.get('terminal')?.descriptor.zone).toBe('drawer');
  });

  it('closes a panel by setting zone to null', () => {
    const reg = new PanelRegistry();
    reg.register(makeDescriptor({ id: 'terminal', zone: 'primary' }));
    reg.setZone('terminal', null);
    expect(reg.getClosed().map((d) => d.id)).toEqual(['terminal']);
  });

  it('lists all registered ids', () => {
    const reg = new PanelRegistry();
    reg.register(makeDescriptor({ id: 'a' }));
    reg.register(makeDescriptor({ id: 'b' }));
    expect(reg.ids()).toEqual(['a', 'b']);
  });

  it('notifies listeners on changes', () => {
    const reg = new PanelRegistry();
    const listener = vi.fn();
    reg.onChange(listener);

    reg.register(makeDescriptor({ id: 'x' }));
    expect(listener).toHaveBeenCalledTimes(1);

    reg.setZone('x', 'drawer');
    expect(listener).toHaveBeenCalledTimes(2);

    reg.unregister('x');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('unsubscribes listeners', () => {
    const reg = new PanelRegistry();
    const listener = vi.fn();
    const unsub = reg.onChange(listener);

    reg.register(makeDescriptor({ id: 'y' }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    reg.register(makeDescriptor({ id: 'z' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
