import { uint8ToBase64 } from '@slicc/shared-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabPage } from '../../../src/cdp/tab-handle.js';
import type { PageInfo } from '../../../src/cdp/types.js';
import {
  BridgedTabComputerBackend,
  dispatchTabEvent,
  inputTab,
  LocalTabComputerBackend,
  refuseSliccAppTab,
  resolveTabPage,
  screenshotTab,
  tabComputerId,
} from '../../../src/computers/adapters/tab.js';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';
import {
  ComputerRegistry,
  resetComputerRegistryForTests,
} from '../../../src/computers/registry.js';

const JPEG_B64 = uint8ToBase64(MINIMAL_JPEG);

const EXAMPLE: PageInfo = {
  targetId: 'T1',
  title: 'Example',
  url: 'https://example.test/',
};

afterEach(() => {
  resetComputerRegistryForTests();
});

function makeTab() {
  const sent: Array<{ method: string; params: unknown }> = [];
  const tab = {
    send: vi.fn(async (method: string, params?: unknown) => {
      sent.push({ method, params });
      return {};
    }),
    screenshot: vi.fn(async () => JPEG_B64),
  };
  return { tab: tab as unknown as TabPage, raw: tab, sent };
}

function makeBrowser(pages: PageInfo[], tab: TabPage) {
  return {
    listAllTargets: vi.fn(async () => pages),
    withTab: vi.fn(async (_id: string, fn: (t: TabPage) => Promise<unknown>) => fn(tab)),
  };
}

describe('tab helpers', () => {
  it('builds tab:<targetId> ids and refuses SLICC app URLs', () => {
    expect(tabComputerId('T1')).toBe('tab:T1');
    expect(() => refuseSliccAppTab({ url: 'https://example.test/' })).not.toThrow();
    expect(() => refuseSliccAppTab({ url: 'https://www.sliccy.ai/', title: 'SLICC' })).toThrow(
      /refusing SLICC app tab/
    );
  });

  it('resolves a tab by targetId, unique url, or unique title', () => {
    const pages: PageInfo[] = [
      EXAMPLE,
      { targetId: 'T2', title: 'Docs', url: 'https://docs.example.test/a' },
    ];
    expect(resolveTabPage(pages, 'T1')).toEqual(EXAMPLE);
    expect(resolveTabPage(pages, 'https://example.test/')).toEqual(EXAMPLE);
    expect(resolveTabPage(pages, 'Docs')).toMatchObject({ targetId: 'T2' });
    expect(resolveTabPage(pages, 'nope')).toEqual({ error: "no tab matching 'nope'" });
  });
});

describe('dispatchTabEvent', () => {
  it('maps mouse, scroll, key, and text onto CDP', async () => {
    const { tab, sent } = makeTab();
    await dispatchTabEvent(tab, { type: 'mousemove', x: 3, y: 4 });
    await dispatchTabEvent(tab, { type: 'click', button: 1, count: 2, x: 8, y: 9 });
    await dispatchTabEvent(tab, { type: 'scroll', dx: 1, dy: 2, x: 8, y: 9 });
    await dispatchTabEvent(tab, { type: 'key', keysym: 'Return' });
    await dispatchTabEvent(tab, { type: 'text', text: 'hi' });
    expect(sent).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 3, y: 4 } },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 8, y: 9, button: 'left', clickCount: 1 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: 8, y: 9, button: 'left', clickCount: 1 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 8, y: 9, button: 'left', clickCount: 2 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: 8, y: 9, button: 'left', clickCount: 2 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseWheel', x: 8, y: 9, deltaX: 1, deltaY: 2 },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 0 },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 },
      },
      { method: 'Input.insertText', params: { text: 'hi' } },
    ]);
    await expect(dispatchTabEvent(tab, { type: 'key', keysym: 'not-a-key' })).rejects.toThrow(
      /unknown keysym/
    );
  });

  it('reuses the last pointer when click/scroll omit coordinates', async () => {
    const { tab, sent } = makeTab();
    const pointer = { x: 0, y: 0 };
    await dispatchTabEvent(tab, { type: 'mousemove', x: 100, y: 80 }, pointer);
    await dispatchTabEvent(tab, { type: 'click', button: 1, count: 1 }, pointer);
    const click = sent.find(
      (s) =>
        s.method === 'Input.dispatchMouseEvent' &&
        (s.params as { type?: string }).type === 'mousePressed'
    );
    expect(click?.params).toMatchObject({ x: 100, y: 80 });
  });
});

describe('LocalTabComputerBackend', () => {
  it('screenshots via withTab and detaches without closing the page', async () => {
    const { tab, raw } = makeTab();
    const browser = makeBrowser([EXAMPLE], tab);
    const backend = new LocalTabComputerBackend(browser as never, 'T1', EXAMPLE);
    expect(backend.describe()).toMatchObject({
      id: 'tab:T1',
      kind: 'tab',
      title: 'Example',
      capabilities: { mouse: 'absolute' },
    });
    const shot = await backend.screenshot({ format: 'jpeg' });
    expect(shot).toMatchObject({ mime: 'image/jpeg', width: 1, height: 1, seq: 1 });
    expect(raw.screenshot).toHaveBeenCalledWith(expect.objectContaining({ format: 'png' }));
    expect(raw.screenshot.mock.calls[0][0]).not.toHaveProperty('foregroundFallback', false);
    await backend.input([{ type: 'text', text: 'x' }]);
    await backend.close();
    expect(browser.withTab).toHaveBeenCalledTimes(2);
  });

  it('refuses a SLICC app tab on screenshot and input', async () => {
    const { tab } = makeTab();
    const app: PageInfo = { targetId: 'APP', title: 'SLICC', url: 'https://www.sliccy.ai/' };
    const browser = makeBrowser([app], tab);
    const backend = new LocalTabComputerBackend(browser as never, 'APP', app);
    await expect(backend.screenshot({ format: 'jpeg' })).rejects.toThrow(/refusing SLICC app tab/);
    await expect(backend.input([{ type: 'text', text: 'x' }])).rejects.toThrow(/refusing/);
  });
});

describe('BridgedTabComputerBackend', () => {
  it('forwards screenshot and input over panel-RPC', async () => {
    const call = vi.fn(async (op: string) => {
      if (op === 'computer-tab-screenshot') {
        return {
          mime: 'image/jpeg' as const,
          base64: JPEG_B64,
          width: 2,
          height: 3,
          title: 'Example',
          url: 'https://example.test/',
        };
      }
      return { ok: true as const };
    });
    const backend = new BridgedTabComputerBackend({ call } as never, 'T1', EXAMPLE);
    const shot = await backend.screenshot({ format: 'jpeg', maxWidth: 768 });
    expect(shot).toMatchObject({ width: 2, height: 3, mime: 'image/jpeg' });
    expect(call).toHaveBeenCalledWith('computer-tab-screenshot', {
      targetId: 'T1',
      maxWidth: 768,
      format: 'jpeg',
    });
    await backend.input([{ type: 'click', button: 1, count: 1, x: 1, y: 2 }]);
    expect(call).toHaveBeenCalledWith('computer-tab-input', {
      targetId: 'T1',
      events: [{ type: 'click', button: 1, count: 1, x: 1, y: 2 }],
    });
  });
});

describe('page-side screenshotTab / inputTab', () => {
  it('captures JPEG bytes and dispatches events', async () => {
    const { tab, sent } = makeTab();
    const browser = makeBrowser([EXAMPLE], tab);
    const shot = await screenshotTab(browser as never, 'T1', { format: 'jpeg' });
    expect(shot).toMatchObject({ mime: 'image/jpeg', url: EXAMPLE.url, width: 1, height: 1 });
    await inputTab(browser as never, 'T1', [{ type: 'button', button: 3, down: true, x: 1, y: 1 }]);
    expect(sent.some((s) => s.method === 'Input.dispatchMouseEvent')).toBe(true);
  });

  it('refuses SLICC app tabs before touching CDP', async () => {
    const { tab, raw } = makeTab();
    const app: PageInfo = { targetId: 'APP', title: 'SLICC', url: 'https://www.sliccy.ai/' };
    const browser = makeBrowser([app], tab);
    await expect(screenshotTab(browser as never, 'APP', {})).rejects.toThrow(/refusing/);
    await expect(inputTab(browser as never, 'APP', [])).rejects.toThrow(/refusing/);
    expect(raw.screenshot).not.toHaveBeenCalled();
    expect(browser.withTab).not.toHaveBeenCalled();
  });
});

describe('computer registry + tab backend', () => {
  it('registers a local tab computer without a pid', () => {
    const { tab } = makeTab();
    const browser = makeBrowser([EXAMPLE], tab);
    const registry = new ComputerRegistry(null);
    const desc = registry.register(new LocalTabComputerBackend(browser as never, 'T1', EXAMPLE));
    expect(desc.id).toBe('tab:T1');
    expect(desc.pid).toBeNull();
  });
});
