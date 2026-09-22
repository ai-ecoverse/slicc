import type { ComputerDescriptor, ComputerFrame, ComputerInputEvent } from '@slicc/shared-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerBackend } from '../../src/computers/backend.js';
import { MINIMAL_JPEG } from '../../src/computers/encode-frame.js';
import {
  installComputerRegistry,
  resetComputerRegistryForTests,
} from '../../src/computers/registry.js';
import { ProcessManager } from '../../src/kernel/process-manager.js';

class FakeBackend implements ComputerBackend {
  closed = false;
  events: ComputerInputEvent[] = [];

  constructor(private readonly id: string) {}

  describe(): ComputerDescriptor {
    return {
      id: this.id,
      kind: 'jsh',
      title: this.id,
      size: { width: 64, height: 48 },
      state: 'live',
      capabilities: {
        screenshot: true,
        text: false,
        frames: 'poll',
        keyboard: true,
        mouse: 'absolute',
        scroll: true,
        exec: false,
        inputAllowed: true,
      },
      pid: null,
    };
  }

  async screenshot(): Promise<ComputerFrame> {
    return {
      seq: 1,
      mime: 'image/jpeg',
      width: 64,
      height: 48,
      bytes: MINIMAL_JPEG,
    };
  }

  async input(events: ComputerInputEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

afterEach(() => {
  resetComputerRegistryForTests();
});

describe('ComputerRegistry', () => {
  it('spawns a kind=computer process when no pid is adopted', () => {
    const pm = new ProcessManager();
    const registry = installComputerRegistry(pm);
    const desc = registry.register(new FakeBackend('fake'));
    expect(desc.pid).toBe(1024);
    expect(pm.get(1024)?.kind).toBe('computer');
  });

  it('adopts an existing pid without spawning', () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({
      kind: 'net',
      argv: ['v86', 'start'],
      owner: { kind: 'system' },
    });
    const registry = installComputerRegistry(pm);
    const desc = registry.register(new FakeBackend('v86:vm0'), { pid: proc.pid });
    expect(desc.pid).toBe(proc.pid);
    expect(pm.list().filter((p) => p.kind === 'computer')).toHaveLength(0);
  });

  it('closes the backend when the adopted process aborts', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({
      kind: 'net',
      argv: ['v86'],
      owner: { kind: 'system' },
    });
    const registry = installComputerRegistry(pm);
    const backend = new FakeBackend('v86:vm0');
    registry.register(backend, { pid: proc.pid });
    pm.signal(proc.pid, 'SIGKILL');
    await vi.waitFor(() => {
      expect(backend.closed).toBe(true);
      expect(registry.get('v86:vm0')).toBeNull();
    });
  });

  it('unregister closes the backend and exits an owned pid', async () => {
    const pm = new ProcessManager();
    const registry = installComputerRegistry(pm);
    const backend = new FakeBackend('owned');
    const desc = registry.register(backend);
    expect(await registry.unregister(desc.id)).toBe(true);
    expect(backend.closed).toBe(true);
    expect(pm.get(desc.pid!)?.status).toMatch(/exited|killed/);
  });

  it('replacing an id exits the owned pid and closes the previous backend', async () => {
    const pm = new ProcessManager();
    const registry = installComputerRegistry(pm);
    const first = new FakeBackend('tab:T1');
    const firstDesc = registry.register(first);
    const firstPid = firstDesc.pid!;
    expect(pm.get(firstPid)?.kind).toBe('computer');
    const second = new FakeBackend('tab:T1');
    const secondDesc = registry.register(second);
    await vi.waitFor(() => {
      expect(first.closed).toBe(true);
    });
    expect(pm.get(firstPid)?.status).toMatch(/exited|killed/);
    expect(secondDesc.pid).not.toBe(firstPid);
    expect(pm.get(secondDesc.pid!)?.kind).toBe('computer');
    expect(registry.get('tab:T1')).toBe(second);
  });

  it('refresh re-emits the live descriptor without closing the backend', () => {
    const registry = installComputerRegistry(null);
    const backend = new FakeBackend('v86:vm0');
    const seen: string[][] = [];
    registry.onChange((list) => seen.push(list.map((c) => c.id)));
    registry.register(backend);
    expect(registry.refresh('v86:vm0')?.id).toBe('v86:vm0');
    expect(backend.closed).toBe(false);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it('use remembers lastUsedId', () => {
    const registry = installComputerRegistry(null);
    registry.register(new FakeBackend('a'));
    registry.register(new FakeBackend('b'));
    expect(registry.use('b')?.id).toBe('b');
    expect(registry.lastUsedId()).toBe('b');
  });

  it('holds the assigned name beside the backend and drops it on unregister', async () => {
    const registry = installComputerRegistry(null);
    registry.register(new FakeBackend('a'), { name: 'probe' });
    registry.register(new FakeBackend('b'));
    expect(registry.nameOf('a')).toBe('probe');
    expect(registry.nameOf('b')).toBeNull();
    expect(registry.nameOf('missing')).toBeNull();

    expect(registry.list().find((c) => c.id === 'a')).not.toHaveProperty('name');
    await registry.unregister('a');
    expect(registry.nameOf('a')).toBeNull();
  });

  it('rememberFrame updates the still and seq but leaves lastShot untouched', () => {
    const registry = installComputerRegistry(null);
    registry.register(new FakeBackend('fake'));
    registry.rememberShot('fake', { width: 500, height: 250, scale: 0.5, at: 1 });
    const frame: ComputerFrame = {
      seq: 7,
      mime: 'image/jpeg',
      width: 400,
      height: 200,
      bytes: MINIMAL_JPEG,
    };
    registry.rememberFrame('fake', frame);
    expect(registry.lastFrame('fake')).toBe(frame);

    expect(registry.getEntry('fake')?.descriptor.lastShot).toEqual({
      width: 500,
      height: 250,
      scale: 0.5,
      at: 1,
    });
    expect(registry.nextSeq('fake')).toBe(8);
  });

  it('rememberFrame is a no-op for an unknown id', () => {
    const registry = installComputerRegistry(null);
    expect(() =>
      registry.rememberFrame('missing', {
        seq: 1,
        mime: 'image/jpeg',
        width: 1,
        height: 1,
        bytes: MINIMAL_JPEG,
      })
    ).not.toThrow();
    expect(registry.lastFrame('missing')).toBeNull();
  });
});
