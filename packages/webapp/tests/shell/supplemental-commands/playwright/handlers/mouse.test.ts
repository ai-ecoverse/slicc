import { describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../../../../src/fs/index.js';
import {
  dropHandler,
  mousedownHandler,
  mousemoveHandler,
  mouseupHandler,
  mousewheelHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/mouse.js';
import type { TabSnapshot } from '../../../../../src/shell/supplemental-commands/playwright/types.js';
import {
  createHandlerCtx,
  createMockBrowser,
  createMockTransport,
  createPlaywrightState,
} from '../../../helpers/playwright-harness.js';

const TAB = 'tab-1';

function makeSnapshot(over: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    url: 'https://x',
    title: 't',
    content: '',
    timestamp: 0,
    refToSelector: new Map(),
    refToBackendNodeId: new Map(),
    refToFrameId: new Map(),
    ...over,
  };
}

describe('mousemove handler', () => {
  it('requires two coordinates', async () => {
    const r = await mousemoveHandler(createHandlerCtx({ positional: ['1'], flags: { tab: TAB } }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('requires <x> <y>');
  });

  it('rejects non-numeric coordinates', async () => {
    const r = await mousemoveHandler(
      createHandlerCtx({ positional: ['a', 'b'], flags: { tab: TAB } })
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('must be numbers');
  });

  it('dispatches a mouseMoved event and records the position', async () => {
    const { browser, transport } = createMockBrowser();
    const state = createPlaywrightState();
    const r = await mousemoveHandler(
      createHandlerCtx({ browser, state, positional: ['10', '20'], flags: { tab: TAB } })
    );
    expect(r.stdout).toBe('Mouse moved to (10, 20)\n');
    expect(transport.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseMoved', x: 10, y: 20 }),
      'session-1'
    );
    expect(state.lastMousePosition.get(TAB)).toEqual({ x: 10, y: 20 });
  });
});

describe('mousedown / mouseup handlers', () => {
  it('require a --tab flag', async () => {
    const r = await mousedownHandler(createHandlerCtx());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--tab');
  });

  it('reject an invalid button', async () => {
    const r = await mousedownHandler(
      createHandlerCtx({ positional: ['sideways'], flags: { tab: TAB } })
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Invalid button');
  });

  it('press at the last recorded position, defaulting to origin', async () => {
    const { browser, transport } = createMockBrowser();
    const down = await mousedownHandler(
      createHandlerCtx({ browser, positional: ['right'], flags: { tab: TAB } })
    );
    expect(down.stdout).toBe('Mouse button right pressed\n');
    expect(transport.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', button: 'right', x: 0, y: 0 }),
      'session-1'
    );
  });

  it('release uses the recorded mouse position', async () => {
    const { browser, transport } = createMockBrowser();
    const state = createPlaywrightState();
    state.lastMousePosition.set(TAB, { x: 5, y: 6 });
    const up = await mouseupHandler(createHandlerCtx({ browser, state, flags: { tab: TAB } }));
    expect(up.stdout).toBe('Mouse button left released\n');
    expect(transport.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseReleased', x: 5, y: 6 }),
      'session-1'
    );
  });
});

describe('mousewheel handler', () => {
  it('requires two deltas and rejects non-numbers', async () => {
    const missing = await mousewheelHandler(
      createHandlerCtx({ positional: ['1'], flags: { tab: TAB } })
    );
    expect(missing.stderr).toContain('requires <dx> <dy>');
    const nan = await mousewheelHandler(
      createHandlerCtx({ positional: ['a', 'b'], flags: { tab: TAB } })
    );
    expect(nan.stderr).toContain('must be numbers');
  });

  it('dispatches a mouseWheel event', async () => {
    const { browser, transport } = createMockBrowser();
    const r = await mousewheelHandler(
      createHandlerCtx({ browser, positional: ['3', '-4'], flags: { tab: TAB } })
    );
    expect(r.stdout).toBe('Mouse wheel scrolled (dx=3, dy=-4)\n');
    expect(transport.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseWheel', deltaX: 3, deltaY: -4 }),
      'session-1'
    );
  });
});

describe('drop handler', () => {
  it('requires a ref', async () => {
    const r = await dropHandler(createHandlerCtx({ flags: { tab: TAB } }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('drop requires a ref');
  });

  it('rejects a malformed --data value', async () => {
    const r = await dropHandler(
      createHandlerCtx({ positional: ['e5'], flags: { tab: TAB, data: 'noequals' } })
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--data format must be');
  });

  it('drops a VFS file via backendNodeId', async () => {
    const transport = createMockTransport((method) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'o1' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: 'DIV' } };
      return {};
    });
    const { browser } = createMockBrowser({ transport });
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToBackendNodeId: new Map([['e5', 9]]) }));
    const readFile = vi.fn(async () => 'file-bytes');
    const r = await dropHandler(
      createHandlerCtx({
        browser,
        state,
        positional: ['e5'],
        flags: { tab: TAB, path: '/upload.txt' },
        fs: { readFile: readFile as unknown as VirtualFS['readFile'] },
      })
    );
    expect(r.stdout).toBe('Dropped onto e5\n');
    expect(readFile).toHaveBeenCalledWith('/upload.txt');
    expect(state.snapshots.has(TAB)).toBe(false);
  });

  it('surfaces a drop exception from the page', async () => {
    const transport = createMockTransport((method) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'o1' } };
      if (method === 'Runtime.callFunctionOn') return { exceptionDetails: { text: 'nope' } };
      return {};
    });
    const { browser } = createMockBrowser({ transport });
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToBackendNodeId: new Map([['e5', 9]]) }));
    await expect(
      dropHandler(createHandlerCtx({ browser, state, positional: ['e5'], flags: { tab: TAB } }))
    ).rejects.toThrow('nope');
  });

  it('falls back to a CSS selector when no backendNodeId exists', async () => {
    const transport = createMockTransport(() => ({}));
    const { browser } = createMockBrowser({ transport });
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToSelector: new Map([['e5', '#zone']]) }));
    const r = await dropHandler(
      createHandlerCtx({
        browser,
        state,
        positional: ['e5'],
        flags: { tab: TAB, data: 'text/plain=hi' },
      })
    );
    expect(r.stdout).toBe('Dropped onto e5\n');
    expect(transport.send).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('#zone') }),
      'session-1'
    );
  });

  it('rejects a missing snapshot and an unknown ref', async () => {
    const { browser } = createMockBrowser();
    await expect(
      dropHandler(
        createHandlerCtx({
          browser,
          state: createPlaywrightState(),
          positional: ['e5'],
          flags: { tab: TAB },
        })
      )
    ).rejects.toThrow('No snapshot');

    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot());
    await expect(
      dropHandler(createHandlerCtx({ browser, state, positional: ['e9'], flags: { tab: TAB } }))
    ).rejects.toThrow('Unknown ref');
  });
});
