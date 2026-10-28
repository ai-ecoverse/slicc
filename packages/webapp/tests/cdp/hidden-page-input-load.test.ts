import { describe, expect, it, vi } from 'vitest';
import { fakeHiddenTab } from '../helpers/fake-hidden-tab.js';

const loads = vi.hoisted(() => ({ attempts: 0 }));

vi.mock('../../src/cdp/hidden-page-input.js', () => {
  loads.attempts += 1;
  throw new Error('Failed to fetch dynamically imported module');
});

describe('hidden-page gate that fails to load', () => {
  it('sends pointer input as is and tries again on the next send', async () => {
    const { BrowserAPI } = await import('../../src/cdp/browser-api.js');
    const tab = fakeHiddenTab({ visible: true });
    const api = new BrowserAPI(tab.client);
    for (const x of [1, 2]) {
      await api.withTab('t1', (page) =>
        page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: x })
      );
    }
    expect(tab.steps()).toEqual(['mouseMoved', 'mouseMoved']);
    expect(loads.attempts).toBe(2);
  });
});
