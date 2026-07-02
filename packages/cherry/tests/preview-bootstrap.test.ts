import { describe, expect, it, vi } from 'vitest';
import { createPreviewBridge } from '../src/preview-bootstrap.js';

describe('preview bootstrap', () => {
  it('answers Runtime.evaluate cdp.req with a cdp.res', async () => {
    const sent: any[] = [];
    const fakeWs = {
      send: (s: string) => sent.push(JSON.parse(s)),
      addEventListener: () => {},
      close: () => {},
    };
    const bridge = createPreviewBridge({
      ws: fakeWs as any,
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
    });
    await bridge.handleFrame({
      t: 'cdp.req',
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
    });
    expect(sent).toContainEqual(expect.objectContaining({ t: 'cdp.res', id: 1 }));
  });

  it('slicc.emit beacons to /__slicc/emit', () => {
    const beacon = vi.fn();
    (navigator as any).sendBeacon = beacon;
    const bridge = createPreviewBridge({
      ws: { send: () => {}, addEventListener: () => {}, close: () => {} } as any,
    });
    bridge.installWindowApi();
    (window as any).slicc.emit('clicked', { id: 3 });
    expect(beacon).toHaveBeenCalledWith('/__slicc/emit', expect.stringContaining('clicked'));
  });
});
