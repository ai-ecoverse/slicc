import { describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../../../../src/fs/index.js';
import {
  dropHandler,
  mousedownHandler,
  mousemoveHandler,
  mouseupHandler,
  mousewheelHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/mouse.js';
import {
  allBytesFixture,
  countReplacementSeqs,
  createHandlerCtx,
  createMockBrowser,
  createMockTransport,
  createPlaywrightState,
  makeTabSnapshot,
  snapshotRefs,
  vfsLikeReadFile,
} from '../../../helpers/playwright-harness.js';

const TAB = 'tab-1';

type DroppedFile = { name: string; type: string; base64: string };
type TransportCall = { method: string; params: Record<string, unknown> };

function decodeBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** Recover the `files` array the handler sent to the dropped-on element. */
function droppedFiles(calls: TransportCall[]): DroppedFile[] {
  const callFn = calls.find((c) => c.method === 'Runtime.callFunctionOn');
  const args = callFn?.params['arguments'] as Array<{ value: unknown }> | undefined;
  return (args?.[0]?.value ?? []) as DroppedFile[];
}

/**
 * Mock browser whose page records every CDP call; `e5` resolves to node 9
 * (and `f1e5`'s local `e5` likewise).
 */
function captureBrowser(): {
  browser: ReturnType<typeof createMockBrowser>;
  calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
  const browser = createMockBrowser({
    nodeIds: { e5: 9 },
    sendCdpImpl: (method, params) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === 'Runtime.callFunctionOn') return { result: { value: 'DIV' } };
      return {};
    },
  });
  return { browser, calls };
}

/** State whose tab snapshot prints exactly these refs. */
function stateWithRefs(...printed: string[]) {
  const state = createPlaywrightState();
  state.snapshots.set(TAB, makeTabSnapshot({ refs: snapshotRefs(...printed) }));
  return state;
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

  it('scrolls a background tab from the page instead of dispatching a wheel event', async () => {
    // A hidden tab draws no frames, so Chrome never acknowledges a wheel event and the
    // dispatch would hang until the 30 s CDP timeout.
    const calls: TransportCall[] = [];
    const transport = createMockTransport((method, params) => {
      calls.push({ method, params: params ?? {} });
      if (method === 'Runtime.evaluate' && params?.['expression'] === 'document.visibilityState') {
        return { result: { value: 'hidden' } };
      }
      return { result: { value: true } };
    });
    const { browser } = createMockBrowser({ transport });
    const state = createPlaywrightState();
    state.lastMousePosition.set(TAB, { x: 40, y: 50 });
    const r = await mousewheelHandler(
      createHandlerCtx({ browser, state, positional: ['0', '600'], flags: { tab: TAB } })
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('Mouse wheel scrolled (dx=0, dy=600)\n');
    expect(r.stderr).toContain('background');
    expect(calls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false);
    const scroll = calls.find(
      (c) => c.method === 'Runtime.evaluate' && String(c.params['expression']).includes('scrollBy')
    );
    expect(String(scroll?.params['expression'])).toContain('elementFromPoint(40, 50)');
    expect(String(scroll?.params['expression'])).toContain('dy = 600');
  });

  it('fails instead of reporting a scroll when the page-side scroll throws', async () => {
    const transport = createMockTransport((method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      if (params?.['expression'] === 'document.visibilityState') {
        return { result: { value: 'hidden' } };
      }
      return {
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'EvalError: blocked by CSP' },
        },
      };
    });
    const { browser } = createMockBrowser({ transport });
    await expect(
      mousewheelHandler(
        createHandlerCtx({ browser, positional: ['0', '600'], flags: { tab: TAB } })
      )
    ).rejects.toThrow('blocked by CSP');
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

  it('drops a VFS file onto the resolved element', async () => {
    const { browser, calls } = captureBrowser();
    const state = stateWithRefs('e5');
    const readFile = vi.fn(async () => 'file-bytes');
    const r = await dropHandler(
      createHandlerCtx({
        browser: browser.browser,
        state,
        positional: ['e5'],
        flags: { tab: TAB, path: '/upload.txt' },
        fs: { readFile: readFile as unknown as VirtualFS['readFile'] },
      })
    );
    expect(r.stdout).toBe('Dropped onto e5\n');
    expect(readFile).toHaveBeenCalledWith('/upload.txt', { encoding: 'binary' });
    expect(calls.find((c) => c.method === 'Runtime.callFunctionOn')?.params['objectId']).toBe(
      'obj-e5'
    );
    expect(state.snapshots.has(TAB)).toBe(false);
  });

  it('drops onto an iframe ref in its own frame', async () => {
    const { browser, calls } = captureBrowser();
    const r = await dropHandler(
      createHandlerCtx({
        browser: browser.browser,
        state: stateWithRefs('f1e5'),
        positional: ['f1e5'],
        flags: { tab: TAB, data: 'text/plain=hi' },
      })
    );
    expect(r.stdout).toBe('Dropped onto f1e5\n');
    expect(browser.page.resolveAriaRef).toHaveBeenCalledWith('e5', 'frame-1');
    expect(calls.some((c) => c.method === 'Runtime.callFunctionOn')).toBe(true);
  });

  it('surfaces a drop exception from the page', async () => {
    const { browser } = createMockBrowser({
      nodeIds: { e5: 9 },
      sendCdpImpl: (method) =>
        method === 'Runtime.callFunctionOn' ? { exceptionDetails: { text: 'nope' } } : {},
    });
    await expect(
      dropHandler(
        createHandlerCtx({
          browser,
          state: stateWithRefs('e5'),
          positional: ['e5'],
          flags: { tab: TAB },
        })
      )
    ).rejects.toThrow('nope');
  });

  it('refuses a ref whose element left the page', async () => {
    const { browser, calls } = captureBrowser();
    await expect(
      dropHandler(
        createHandlerCtx({
          browser: browser.browser,
          state: stateWithRefs('e6'),
          positional: ['e6'],
          flags: { tab: TAB, data: 'text/plain=hi' },
        })
      )
    ).rejects.toThrow('Ref "e6" (button) is no longer on the page');
    expect(calls.some((c) => c.method === 'Runtime.callFunctionOn')).toBe(false);
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

    await expect(
      dropHandler(
        createHandlerCtx({
          browser,
          state: stateWithRefs(),
          positional: ['e9'],
          flags: { tab: TAB },
        })
      )
    ).rejects.toThrow('Unknown ref');
  });
});

describe('drop --path binary fidelity (#2883)', () => {
  it('drops the 0x00..0xFF fixture byte-exactly', async () => {
    const fixture = allBytesFixture();
    const files = new Map<string, string | Uint8Array>([['/allbytes.bin', fixture]]);
    const { browser: mock, calls } = captureBrowser();
    const { browser } = mock;
    const state = stateWithRefs('e5');

    const r = await dropHandler(
      createHandlerCtx({
        browser,
        state,
        positional: ['e5'],
        flags: { tab: TAB, path: '/allbytes.bin' },
        fs: { readFile: vfsLikeReadFile(files) },
      })
    );

    expect(r.exitCode).toBe(0);
    expect(calls.some((c) => c.method === 'Runtime.callFunctionOn')).toBe(true);
    const dropped = droppedFiles(calls);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].type).toBe('application/octet-stream');
    const decoded = decodeBase64(dropped[0].base64);
    expect(decoded.length).toBe(256);
    expect(countReplacementSeqs(decoded)).toBe(0);
    expect(Array.from(decoded)).toEqual(Array.from(fixture));
  });

  it('still drops ASCII and valid UTF-8 text unchanged', async () => {
    const text = 'hello café — plain ASCII plus valid UTF-8';
    const files = new Map<string, string | Uint8Array>([['/note.txt', text]]);
    const { browser: mock, calls } = captureBrowser();
    const { browser } = mock;
    const state = stateWithRefs('e5');

    const r = await dropHandler(
      createHandlerCtx({
        browser,
        state,
        positional: ['e5'],
        flags: { tab: TAB, path: '/note.txt' },
        fs: { readFile: vfsLikeReadFile(files) },
      })
    );

    expect(r.exitCode).toBe(0);
    const dropped = droppedFiles(calls);
    expect(dropped[0].type).toBe('text/plain');
    const decoded = decodeBase64(dropped[0].base64);
    expect(new TextDecoder().decode(decoded)).toBe(text);
    expect(countReplacementSeqs(decoded)).toBe(0);
  });

  it('fails instead of dropping a payload a text decode already mangled', async () => {
    const { browser } = captureBrowser().browser;
    const state = stateWithRefs('e5');

    await expect(
      dropHandler(
        createHandlerCtx({
          browser,
          state,
          positional: ['e5'],
          flags: { tab: TAB, path: '/corrupt.bin' },
          fs: { readFile: (async () => 'JFIF\uFFFD\uFFFD') as unknown as VirtualFS['readFile'] },
        })
      )
    ).rejects.toThrow(/faithfully/);
  });
});
