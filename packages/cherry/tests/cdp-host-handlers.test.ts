import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CherryUnsupportedError, createCdpHostHandler } from '../src/cdp-host-handlers.js';

describe('createCdpHostHandler', () => {
  let handle: ReturnType<typeof createCdpHostHandler>;
  beforeEach(() => {
    const btn = document.createElement('button');
    btn.id = 'b';
    btn.textContent = 'Hi';
    document.body.replaceChildren(btn);
    handle = createCdpHostHandler({
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
    });
  });

  it('Runtime.evaluate returns a primitive remote object', async () => {
    const res = await handle('Runtime.evaluate', { expression: '40 + 2' });
    expect(res.result).toMatchObject({ type: 'number', value: 42 });
  });

  it('Runtime.evaluate surfaces thrown errors as exceptionDetails', async () => {
    const res = await handle('Runtime.evaluate', { expression: 'throw new Error("boom")' });
    expect(res.exceptionDetails).toBeTruthy();
  });

  it('Runtime.evaluate maps null and undefined remote objects', async () => {
    const nil = await handle('Runtime.evaluate', { expression: 'null' });
    expect(nil.result).toMatchObject({ type: 'object', subtype: 'null', value: null });
    const undef = await handle('Runtime.evaluate', { expression: 'undefined' });
    expect(undef.result).toMatchObject({ type: 'undefined' });
  });

  it('DOM.getDocument returns a root node id', async () => {
    const res = await handle('DOM.getDocument', {});
    expect(typeof (res.root as { nodeId: number }).nodeId).toBe('number');
  });

  it('rejects unsupported methods with -32601', async () => {
    await expect(handle('Network.enable', {})).rejects.toBeInstanceOf(CherryUnsupportedError);
    await expect(handle('Network.enable', {})).rejects.toMatchObject({ code: -32601 });
  });

  it('rejects Object.prototype method names with -32601 instead of an inherited member', async () => {
    for (const method of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      await expect(handle(method, {})).rejects.toBeInstanceOf(CherryUnsupportedError);
      await expect(handle(method, {})).rejects.toMatchObject({ code: -32601 });
    }
  });

  it('Page.captureScreenshot rejects cleanly when screenshot is none', async () => {
    await expect(handle('Page.captureScreenshot', {})).rejects.toBeInstanceOf(
      CherryUnsupportedError
    );
  });

  it('Page.navigate rejects with CherryUnsupportedError when navigate capability is off', async () => {
    const denied = createCdpHostHandler({
      capabilities: { navigate: false, screenshot: 'none', openUrl: true },
    });
    await expect(denied('Page.navigate', { url: 'https://x.example' })).rejects.toBeInstanceOf(
      CherryUnsupportedError
    );
  });

  it('Target.createTarget rejects with CherryUnsupportedError when openUrl capability is off', async () => {
    const denied = createCdpHostHandler({
      capabilities: { navigate: true, screenshot: 'none', openUrl: false },
    });
    await expect(
      denied('Target.createTarget', { url: 'https://x.example' })
    ).rejects.toBeInstanceOf(CherryUnsupportedError);
  });

  it('Target.createTarget invokes onOpenUrl when openUrl is allowed', async () => {
    const onOpenUrl = vi.fn();
    const opened = createCdpHostHandler({
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      onOpenUrl,
    });
    const res = await opened('Target.createTarget', { url: 'https://opened.example' });
    expect(onOpenUrl).toHaveBeenCalledWith('https://opened.example');
    expect(res).toEqual({ targetId: 'cherry-opened' });
  });

  it('DOM.querySelector returns the node id of a matching element', async () => {
    const doc = await handle('DOM.getDocument', {});
    const rootId = (doc.root as { nodeId: number }).nodeId;
    const match = await handle('DOM.querySelector', { nodeId: rootId, selector: '#b' });
    expect(match.nodeId as number).toBeGreaterThan(0);
    const miss = await handle('DOM.querySelector', { nodeId: rootId, selector: '#nope' });
    expect(miss.nodeId).toBe(0);
  });

  it('DOM.getBoxModel returns a content quad for an element node', async () => {
    const doc = await handle('DOM.getDocument', {});
    const rootId = (doc.root as { nodeId: number }).nodeId;
    const match = await handle('DOM.querySelector', { nodeId: rootId, selector: '#b' });
    const box = await handle('DOM.getBoxModel', { nodeId: match.nodeId });
    const model = box.model as { content: number[]; width: number; height: number };
    expect(model.content).toHaveLength(8);
    expect(typeof model.width).toBe('number');
  });

  it('Input.dispatchMouseEvent clicks the element under the point on mousePressed', async () => {
    const btn = document.getElementById('b') as HTMLButtonElement;
    const clicked = vi.fn();
    btn.addEventListener('click', clicked);
    document.elementFromPoint = () => btn;
    await handle('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it('Input.dispatchKeyEvent dispatches keydown on the active element', async () => {
    const btn = document.getElementById('b') as HTMLButtonElement;
    btn.focus();
    const keyed = vi.fn();
    btn.addEventListener('keydown', keyed);
    await handle('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' });
    expect(keyed).toHaveBeenCalledOnce();
    const first = keyed.mock.calls[0]?.[0] as KeyboardEvent;
    expect(first.keyCode).toBe(13);
    expect(first.cancelable).toBe(true);
  });

  const ENTER_KEY_DOWN = {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
    unmodifiedText: '\r',
  };
  const ENTER_KEY_UP = {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  };

  it('Input.dispatchKeyEvent fills key/code/keyCode/which and is cancelable (post-#3768 payload)', async () => {
    const btn = document.getElementById('b') as HTMLButtonElement;
    btn.focus();
    const keyed = vi.fn((ev: KeyboardEvent) => {
      expect(ev.key).toBe('Enter');
      expect(ev.code).toBe('Enter');
      expect(ev.keyCode).toBe(13);
      expect(ev.which).toBe(13);
      expect(ev.cancelable).toBe(true);
      expect(ev.bubbles).toBe(true);
    });
    btn.addEventListener('keydown', keyed);
    await handle('Input.dispatchKeyEvent', ENTER_KEY_DOWN);
    expect(keyed).toHaveBeenCalledOnce();
  });

  it('Input.dispatchKeyEvent dispatches keypress when text is present and keyup on keyUp', async () => {
    const btn = document.getElementById('b') as HTMLButtonElement;
    btn.focus();
    const types: string[] = [];
    for (const type of ['keydown', 'keypress', 'keyup'] as const) {
      btn.addEventListener(type, (ev) => {
        types.push(ev.type);
        expect((ev as KeyboardEvent).keyCode).toBe(13);
      });
    }
    await handle('Input.dispatchKeyEvent', ENTER_KEY_DOWN);
    await handle('Input.dispatchKeyEvent', ENTER_KEY_UP);
    expect(types).toEqual(['keydown', 'keypress', 'keyup']);
  });

  it('Input.dispatchKeyEvent Enter submits a host form (implicit submit)', async () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.type = 'text';
    form.append(input);
    document.body.replaceChildren(form);
    const submitted = vi.fn((ev: Event) => ev.preventDefault());
    form.addEventListener('submit', submitted);
    input.focus();
    await handle('Input.dispatchKeyEvent', ENTER_KEY_DOWN);
    expect(submitted).toHaveBeenCalledOnce();
  });

  it('Input.dispatchKeyEvent does not submit when keypress is preventDefaulted', async () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.type = 'text';
    form.append(input);
    document.body.replaceChildren(form);
    const submitted = vi.fn((ev: Event) => ev.preventDefault());
    form.addEventListener('submit', submitted);
    input.addEventListener('keypress', (ev) => ev.preventDefault());
    input.focus();
    await handle('Input.dispatchKeyEvent', ENTER_KEY_DOWN);
    expect(submitted).not.toHaveBeenCalled();
  });

  it('Input.dispatchKeyEvent does not submit when keydown is preventDefaulted', async () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.type = 'text';
    form.append(input);
    document.body.replaceChildren(form);
    const submitted = vi.fn((ev: Event) => ev.preventDefault());
    form.addEventListener('submit', submitted);
    input.addEventListener('keydown', (ev) => ev.preventDefault());
    input.focus();
    await handle('Input.dispatchKeyEvent', ENTER_KEY_DOWN);
    expect(submitted).not.toHaveBeenCalled();
  });

  it('Input.dispatchKeyEvent uses nativeVirtualKeyCode and rawKeyDown', async () => {
    const btn = document.getElementById('b') as HTMLButtonElement;
    btn.focus();
    const keyed = vi.fn((ev: KeyboardEvent) => {
      expect(ev.keyCode).toBe(65);
      expect(ev.key).toBe('a');
      expect(ev.code).toBe('KeyA');
    });
    btn.addEventListener('keydown', keyed);
    await handle('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      nativeVirtualKeyCode: 65,
      text: 'a',
    });
    expect(keyed).toHaveBeenCalledOnce();
  });

  it('Input.dispatchKeyEvent Enter submits via submit event when requestSubmit is missing', async () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.type = 'text';
    form.append(input);
    document.body.replaceChildren(form);
    Object.defineProperty(form, 'requestSubmit', { value: undefined });
    const submitted = vi.fn((ev: Event) => ev.preventDefault());
    form.addEventListener('submit', submitted);
    input.focus();
    await handle('Input.dispatchKeyEvent', ENTER_KEY_DOWN);
    expect(submitted).toHaveBeenCalledOnce();
  });

  it('Input.dispatchKeyEvent maps char to keypress and ignores unknown types', async () => {
    const btn = document.getElementById('b') as HTMLButtonElement;
    btn.focus();
    const types: string[] = [];
    btn.addEventListener('keypress', (ev) => {
      types.push(ev.type);
      expect(ev.charCode).toBe(13);
    });
    await handle('Input.dispatchKeyEvent', {
      type: 'char',
      key: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await handle('Input.dispatchKeyEvent', { type: 'mouseWheel', key: 'Enter' });
    expect(types).toEqual(['keypress']);
  });

  it('Input.dispatchKeyEvent derives keyCode from a printable key when VK is omitted', async () => {
    const btn = document.getElementById('b') as HTMLButtonElement;
    btn.focus();
    const keyed = vi.fn((ev: KeyboardEvent) => {
      expect(ev.keyCode).toBe('x'.charCodeAt(0));
    });
    btn.addEventListener('keydown', keyed);
    await handle('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x' });
    expect(keyed).toHaveBeenCalledOnce();
  });

  it('Input.dispatchKeyEvent Enter on a submit button uses the button form', async () => {
    const form = document.createElement('form');
    const btn = document.createElement('button');
    btn.type = 'submit';
    form.append(btn);
    document.body.replaceChildren(form);
    const submitted = vi.fn((ev: Event) => ev.preventDefault());
    form.addEventListener('submit', submitted);
    btn.focus();
    await handle('Input.dispatchKeyEvent', ENTER_KEY_DOWN);
    expect(submitted).toHaveBeenCalledOnce();
  });

  it('Input.dispatchKeyEvent Enter on a nested host element submits the closest form', async () => {
    const form = document.createElement('form');
    const wrap = document.createElement('div');
    wrap.tabIndex = 0;
    form.append(wrap);
    document.body.replaceChildren(form);
    const submitted = vi.fn((ev: Event) => ev.preventDefault());
    form.addEventListener('submit', submitted);
    wrap.focus();
    await handle('Input.dispatchKeyEvent', ENTER_KEY_DOWN);
    expect(submitted).toHaveBeenCalledOnce();
  });

  it('Input.dispatchKeyEvent treats text \\r as Enter even without key', async () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    form.append(input);
    document.body.replaceChildren(form);
    const submitted = vi.fn((ev: Event) => ev.preventDefault());
    form.addEventListener('submit', submitted);
    input.focus();
    await handle('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r' });
    expect(submitted).toHaveBeenCalledOnce();
  });

  it('Input.dispatchKeyEvent unknown named keys get keyCode 0', async () => {
    const btn = document.getElementById('b') as HTMLButtonElement;
    btn.focus();
    const keyed = vi.fn((ev: KeyboardEvent) => {
      expect(ev.keyCode).toBe(0);
    });
    btn.addEventListener('keydown', keyed);
    await handle('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
    expect(keyed).toHaveBeenCalledOnce();
  });

  it('Input.dispatchKeyEvent Enter in a textarea does not submit', async () => {
    const form = document.createElement('form');
    const area = document.createElement('textarea');
    form.append(area);
    document.body.replaceChildren(form);
    const submitted = vi.fn((ev: Event) => ev.preventDefault());
    form.addEventListener('submit', submitted);
    area.focus();
    await handle('Input.dispatchKeyEvent', ENTER_KEY_DOWN);
    expect(submitted).not.toHaveBeenCalled();
  });
});
