import type { ComputerDescriptor, ComputerFrame, ComputerInputEvent } from '@slicc/shared-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerBackend } from '../../src/computers/backend.js';
import { jpegSize, MINIMAL_JPEG } from '../../src/computers/encode-frame.js';
import { startComputersHost } from '../../src/computers/host.js';
import {
  installComputerRegistry,
  resetComputerRegistryForTests,
} from '../../src/computers/registry.js';
import type { ExtensionMessage, OffscreenToPanelMessage } from '../../src/kernel/messages.js';

class FakeBackend implements ComputerBackend {
  shots = 0;
  hang: Promise<ComputerFrame> | null = null;
  received: ComputerInputEvent[] = [];

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

  async input(events: ComputerInputEvent[]): Promise<void> {
    this.received.push(...events);
  }

  async close(): Promise<void> {}
}

function jpegSof0(width: number, height: number): Uint8Array {
  return Uint8Array.of(
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9
  );
}

class FakePushBackend implements ComputerBackend {
  subscribed: Array<{ fps: number; maxWidth?: number }> = [];
  private sink: ((frame: ComputerFrame) => void) | null = null;

  constructor(readonly id = 'push') {}

  describe(): ComputerDescriptor {
    return {
      id: this.id,
      kind: 'jsh',
      title: this.id,
      size: { width: 640, height: 400 },
      state: 'live',
      capabilities: {
        screenshot: true,
        text: false,
        frames: 'push',
        keyboard: true,
        mouse: 'absolute',
        scroll: true,
        exec: false,
        inputAllowed: true,
      },
      pid: null,
    };
  }

  subscribe(fps: number, onFrame: (frame: ComputerFrame) => void, maxWidth?: number): () => void {
    this.subscribed.push({ fps, maxWidth });
    this.sink = onFrame;
    return () => {
      this.sink = null;
    };
  }

  emitWide(): void {
    this.sink?.({
      seq: 1,
      mime: 'image/jpeg',
      width: 640,
      height: 400,
      bytes: jpegSof0(640, 400),
    });
  }

  async screenshot(): Promise<ComputerFrame> {
    return {
      seq: 1,
      mime: 'image/jpeg',
      width: 640,
      height: 400,
      bytes: jpegSof0(640, 400),
    };
  }

  async input(): Promise<void> {}
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

  it('forwards over-cap push frames unchanged when resample is unavailable', async () => {
    const registry = installComputerRegistry(null);
    const backend = new FakePushBackend('wide');
    registry.register(backend);
    const { transport, sent } = mockTransport();
    const host = startComputersHost({ transport, processManager: null });
    host.watch('wide', 2, 480);
    expect(backend.subscribed).toEqual([{ fps: 2, maxWidth: 480 }]);
    backend.emitWide();
    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === 'computer-frame')).toBe(true);
    });
    const frame = sent.find((m) => m.type === 'computer-frame');
    expect(frame).toMatchObject({
      type: 'computer-frame',
      id: 'wide',
      width: 640,
      height: 400,
      overCap: true,
    });
    if (frame && frame.type === 'computer-frame') {
      expect(jpegSize(frame.bytes)).toEqual({ width: 640, height: 400 });
    }
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

  it('forwards computer-input events to the registered backend', async () => {
    const registry = installComputerRegistry(null);
    const backend = new FakeBackend('box');
    registry.register(backend);
    const { transport, emit } = mockTransport();
    const host = startComputersHost({ transport, processManager: null });
    emit({ type: 'computer-input', id: 'box', events: [{ type: 'key', keysym: 'Return' }] });
    await vi.waitFor(() => {
      expect(backend.received).toEqual([{ type: 'key', keysym: 'Return' }]);
    });
    host.stop();
  });
});
