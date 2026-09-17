import type { ComputerDescriptor, ComputerFrame, ComputerInputEvent } from '@slicc/shared-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerBackend } from '../../src/computers/backend.js';
import { MINIMAL_JPEG } from '../../src/computers/encode-frame.js';
import { startComputersHost } from '../../src/computers/host.js';
import {
  installComputerRegistry,
  resetComputerRegistryForTests,
} from '../../src/computers/registry.js';
import type { ExtensionMessage, OffscreenToPanelMessage } from '../../src/kernel/messages.js';

class FakeBackend implements ComputerBackend {
  shots = 0;
  hang: Promise<ComputerFrame> | null = null;

  constructor(readonly id = 'fake') {}

  describe(): ComputerDescriptor {
    return {
      id: this.id,
      kind: 'jsh',
      title: this.id,
      size: { width: 8, height: 8 },
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
    this.shots += 1;
    if (this.hang !== null) return this.hang;
    return {
      seq: this.shots,
      mime: 'image/jpeg',
      width: 8,
      height: 8,
      bytes: MINIMAL_JPEG,
    };
  }

  async input(_events: ComputerInputEvent[]): Promise<void> {}

  async close(): Promise<void> {}
}

function mockTransport() {
  const handlers: Array<(msg: ExtensionMessage) => void> = [];
  const sent: OffscreenToPanelMessage[] = [];
  return {
    sent,
    transport: {
      onMessage: (handler: (msg: ExtensionMessage) => void) => {
        handlers.push(handler);
        return () => {
          const i = handlers.indexOf(handler);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
      send: (msg: OffscreenToPanelMessage) => {
        sent.push(msg);
      },
    },
    emit(payload: ExtensionMessage['payload']) {
      const envelope = { source: 'panel' as const, payload };
      for (const handler of handlers) handler(envelope as ExtensionMessage);
    },
  };
}

afterEach(() => {
  resetComputerRegistryForTests();
});

describe('computers host watch transport', () => {
  it('pushes the list, then frames, then stops after unwatch', async () => {
    const registry = installComputerRegistry(null);
    const backend = new FakeBackend('box');
    registry.register(backend);
    const { transport, sent, emit } = mockTransport();
    const host = startComputersHost({ transport, processManager: null, pollTimeoutMs: 50 });
    expect(sent.some((m) => m.type === 'computers')).toBe(true);

    emit({ type: 'computer-watch', id: 'box', fps: 10, maxWidth: 768 });
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'computer-frame')).toHaveLength(1);
    });
    const framesBefore = sent.filter((m) => m.type === 'computer-frame').length;
    emit({ type: 'computer-unwatch', id: 'box' });
    const shots = backend.shots;
    await new Promise((r) => setTimeout(r, 40));
    expect(backend.shots).toBe(shots);
    expect(sent.filter((m) => m.type === 'computer-frame').length).toBe(framesBefore);
    host.stop();
  });

  it('does not overlap in-flight polls and drops stale completions', async () => {
    const registry = installComputerRegistry(null);
    const backend = new FakeBackend('slow');
    let resolveHang: ((frame: ComputerFrame) => void) | undefined;
    backend.hang = new Promise((resolve) => {
      resolveHang = resolve;
    });
    registry.register(backend);
    const { transport, sent } = mockTransport();
    const host = startComputersHost({ transport, processManager: null, pollTimeoutMs: 200 });
    host.watch('slow', 50, 768);
    await vi.waitFor(() => {
      expect(backend.shots).toBe(1);
    });
    host.unwatch('slow');
    resolveHang?.({
      seq: 99,
      mime: 'image/jpeg',
      width: 8,
      height: 8,
      bytes: MINIMAL_JPEG,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.filter((m) => m.type === 'computer-frame')).toHaveLength(0);
    host.stop();
  });

  it('times out a hung screenshot instead of stacking polls', async () => {
    vi.useFakeTimers();
    try {
      const registry = installComputerRegistry(null);
      const backend = new FakeBackend('hung');
      backend.hang = new Promise(() => {
        /* never */
      });
      registry.register(backend);
      const { transport } = mockTransport();
      const host = startComputersHost({ transport, processManager: null, pollTimeoutMs: 30 });
      host.watch('hung', 10, 768);
      expect(backend.shots).toBe(1);
      await vi.advanceTimersByTimeAsync(30);
      await vi.advanceTimersByTimeAsync(100);
      expect(backend.shots).toBeGreaterThanOrEqual(1);
      host.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
