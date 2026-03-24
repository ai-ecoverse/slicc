import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SprinkleBridge } from '../../src/ui/sprinkle-bridge.js';
import type { LickEvent } from '../../src/scoops/lick-manager.js';
import type { VirtualFS } from '../../src/fs/index.js';

describe('SprinkleBridge', () => {
  let bridge: SprinkleBridge;
  let lickHandler: (event: LickEvent) => void;
  let lickHandlerMock: ReturnType<typeof vi.fn>;
  let closeHandler: (name: string) => void;
  let closeHandlerMock: ReturnType<typeof vi.fn>;
  let mockFs: VirtualFS;

  beforeEach(() => {
    lickHandlerMock = vi.fn();
    lickHandler = lickHandlerMock as unknown as (event: LickEvent) => void;
    closeHandlerMock = vi.fn();
    closeHandler = closeHandlerMock as unknown as (name: string) => void;
    mockFs = {
      readFile: vi.fn().mockResolvedValue('file content'),
    } as unknown as VirtualFS;
    bridge = new SprinkleBridge(mockFs, lickHandler, closeHandler);
  });

  it('creates an API with the sprinkle name', () => {
    const api = bridge.createAPI('test-sprinkle');
    expect(api.name).toBe('test-sprinkle');
  });

  it('lick() sends a LickEvent through the handler', () => {
    const api = bridge.createAPI('test-sprinkle');
    api.lick({ action: 'click', data: { id: 42 } });

    expect(lickHandlerMock).toHaveBeenCalledTimes(1);
    const event: LickEvent = lickHandlerMock.mock.calls[0][0];
    expect(event.type).toBe('sprinkle');
    expect(event.sprinkleName).toBe('test-sprinkle');
    expect(event.body).toEqual({ action: 'click', data: { id: 42 } });
  });

  it('lick() accepts a plain string as action shorthand', () => {
    const api = bridge.createAPI('test-sprinkle');
    api.lick('add-year');

    expect(lickHandlerMock).toHaveBeenCalledTimes(1);
    const event: LickEvent = lickHandlerMock.mock.calls[0][0];
    expect(event.type).toBe('sprinkle');
    expect(event.body).toEqual({ action: 'add-year', data: undefined });
  });

  it('close() calls the close handler', () => {
    const api = bridge.createAPI('test-sprinkle');
    api.close();
    expect(closeHandlerMock).toHaveBeenCalledWith('test-sprinkle');
  });

  it('readFile() delegates to VFS', async () => {
    const api = bridge.createAPI('test-sprinkle');
    const content = await api.readFile('/test.txt');
    expect(content).toBe('file content');
    expect(mockFs.readFile).toHaveBeenCalledWith('/test.txt', { encoding: 'utf-8' });
  });

  it('on/off registers and removes update listeners', () => {
    const api = bridge.createAPI('test-sprinkle');
    const cb = vi.fn();

    api.on('update', cb);
    bridge.pushUpdate('test-sprinkle', { status: 'done' });
    expect(cb).toHaveBeenCalledWith({ status: 'done' });

    api.off('update', cb);
    bridge.pushUpdate('test-sprinkle', { status: 'again' });
    expect(cb).toHaveBeenCalledTimes(1); // not called again
  });

  it('pushUpdate only fires for the correct sprinkle', () => {
    const api1 = bridge.createAPI('sprinkle-a');
    const api2 = bridge.createAPI('sprinkle-b');
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    api1.on('update', cb1);
    api2.on('update', cb2);

    bridge.pushUpdate('sprinkle-a', 'data-a');
    expect(cb1).toHaveBeenCalledWith('data-a');
    expect(cb2).not.toHaveBeenCalled();
  });

  it('removeSprinkle cleans up all listeners for that sprinkle', () => {
    const api = bridge.createAPI('test-sprinkle');
    const cb = vi.fn();
    api.on('update', cb);

    bridge.removeSprinkle('test-sprinkle');
    bridge.pushUpdate('test-sprinkle', 'data');
    expect(cb).not.toHaveBeenCalled();
  });

  it('listener errors are silently caught', () => {
    const api = bridge.createAPI('test-sprinkle');
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();

    api.on('update', bad);
    api.on('update', good);

    expect(() => bridge.pushUpdate('test-sprinkle', 'data')).not.toThrow();
    expect(good).toHaveBeenCalledWith('data');
  });
});
