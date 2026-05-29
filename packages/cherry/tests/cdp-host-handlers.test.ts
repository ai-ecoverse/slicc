import { describe, it, expect, beforeEach } from 'vitest';
import { createCdpHostHandler, CherryUnsupportedError } from '../src/cdp-host-handlers.js';

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
    expect((res as any).result.value).toBe(42);
    expect((res as any).result.type).toBe('number');
  });

  it('Runtime.evaluate surfaces thrown errors as exceptionDetails', async () => {
    const res = await handle('Runtime.evaluate', { expression: 'throw new Error("boom")' });
    expect((res as any).exceptionDetails).toBeTruthy();
  });

  it('DOM.getDocument returns a root node id', async () => {
    const res = await handle('DOM.getDocument', {});
    expect(typeof (res as any).root.nodeId).toBe('number');
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
});
