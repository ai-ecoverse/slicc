import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShtmlBridge } from './shtml-bridge.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import type { VirtualFS } from '../fs/index.js';

describe('ShtmlBridge', () => {
  let bridge: ShtmlBridge;
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
    bridge = new ShtmlBridge(mockFs, lickHandler, closeHandler);
  });

  it('creates an API with the panel name', () => {
    const api = bridge.createAPI('test-panel');
    expect(api.name).toBe('test-panel');
  });

  it('lick() sends a LickEvent through the handler', () => {
    const api = bridge.createAPI('test-panel');
    api.lick({ action: 'click', data: { id: 42 } });

    expect(lickHandlerMock).toHaveBeenCalledTimes(1);
    const event: LickEvent = lickHandlerMock.mock.calls[0][0];
    expect(event.type).toBe('panel');
    expect(event.panelName).toBe('test-panel');
    expect(event.body).toEqual({ action: 'click', data: { id: 42 } });
  });

  it('close() calls the close handler', () => {
    const api = bridge.createAPI('test-panel');
    api.close();
    expect(closeHandlerMock).toHaveBeenCalledWith('test-panel');
  });

  it('readFile() delegates to VFS', async () => {
    const api = bridge.createAPI('test-panel');
    const content = await api.readFile('/test.txt');
    expect(content).toBe('file content');
    expect(mockFs.readFile).toHaveBeenCalledWith('/test.txt', { encoding: 'utf-8' });
  });

  it('on/off registers and removes update listeners', () => {
    const api = bridge.createAPI('test-panel');
    const cb = vi.fn();

    api.on('update', cb);
    bridge.pushUpdate('test-panel', { status: 'done' });
    expect(cb).toHaveBeenCalledWith({ status: 'done' });

    api.off('update', cb);
    bridge.pushUpdate('test-panel', { status: 'again' });
    expect(cb).toHaveBeenCalledTimes(1); // not called again
  });

  it('pushUpdate only fires for the correct panel', () => {
    const api1 = bridge.createAPI('panel-a');
    const api2 = bridge.createAPI('panel-b');
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    api1.on('update', cb1);
    api2.on('update', cb2);

    bridge.pushUpdate('panel-a', 'data-a');
    expect(cb1).toHaveBeenCalledWith('data-a');
    expect(cb2).not.toHaveBeenCalled();
  });

  it('removePanel cleans up all listeners for that panel', () => {
    const api = bridge.createAPI('test-panel');
    const cb = vi.fn();
    api.on('update', cb);

    bridge.removePanel('test-panel');
    bridge.pushUpdate('test-panel', 'data');
    expect(cb).not.toHaveBeenCalled();
  });

  it('listener errors are silently caught', () => {
    const api = bridge.createAPI('test-panel');
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();

    api.on('update', bad);
    api.on('update', good);

    expect(() => bridge.pushUpdate('test-panel', 'data')).not.toThrow();
    expect(good).toHaveBeenCalledWith('data');
  });
});
