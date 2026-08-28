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
  });
});
