import { describe, expect, it } from 'vitest';
import { mountSlicc } from '../src/embed-ui.js';
import type { CherrySliccHandle } from '../src/mount.js';

describe('embed-ui mountSlicc', () => {
  it('does not run host-realm CDP (no injected handler)', async () => {
    const container = document.createElement('div');
    const handle = mountSlicc({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
    }) as CherrySliccHandle;
    const res = await handle.testReceive({
      kind: 'cdp.request',
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
    } as never);
    expect(res?.error?.code).toBe(-32601);
    handle.destroy();
  });
});
