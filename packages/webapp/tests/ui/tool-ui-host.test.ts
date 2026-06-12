// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub chrome global absent in jsdom
(globalThis as Record<string, unknown>).chrome = undefined;

// Mock dip.ts handleDipPickerAction
vi.mock('../../src/ui/dip.js', () => ({
  handleDipPickerAction: vi.fn(async (_msg: unknown, onLick: (a: string, d: unknown) => void) => {
    onLick('approve', { handleInIdb: true, idbKey: 'pendingMount:test-1' });
  }),
}));

import { hydrateToolUI } from '../../src/ui/tool-ui-host.js';
import { toolUIHtmlStore } from '../../src/ui/wc/wc-message-view.js';

describe('hydrateToolUI', () => {
  let host: HTMLElement;
  let actions: Array<{ requestId: string; action: string; data: unknown }>;
  let sendToolUIAction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement('div');
    actions = [];
    sendToolUIAction = vi.fn((requestId: string, action: string, data: unknown) => {
      actions.push({ requestId, action, data });
    });
    toolUIHtmlStore.clear();
  });

  it('returns empty array when no [data-tool-ui-id] elements exist', () => {
    const instances = hydrateToolUI(host, { isExtension: false, onAction: sendToolUIAction });
    expect(instances).toHaveLength(0);
  });

  it('creates an iframe inside the container', () => {
    const container = document.createElement('div');
    container.setAttribute('data-tool-ui-id', 'req-1');
    toolUIHtmlStore.set('req-1', '<div class="sprinkle-action-card">test</div>');
    host.appendChild(container);

    hydrateToolUI(host, { isExtension: false, onAction: sendToolUIAction });

    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
  });

  it('dispose removes the iframe', () => {
    const container = document.createElement('div');
    container.setAttribute('data-tool-ui-id', 'req-2');
    toolUIHtmlStore.set('req-2', '<div>test</div>');
    host.appendChild(container);

    const [instance] = hydrateToolUI(host, { isExtension: false, onAction: sendToolUIAction });
    instance.dispose();

    expect(container.querySelector('iframe')).toBeNull();
  });

  it('on tool-ui-action with deny, calls onAction with deny immediately', () => {
    const container = document.createElement('div');
    container.setAttribute('data-tool-ui-id', 'req-3');
    toolUIHtmlStore.set('req-3', '<div>test</div>');
    host.appendChild(container);

    hydrateToolUI(host, { isExtension: false, onAction: sendToolUIAction });

    const iframe = container.querySelector('iframe')!;
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        data: { type: 'tool-ui-action', id: 'req-3', action: 'deny', nonce: '' },
      })
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ requestId: 'req-3', action: 'deny' });
  });

  it('on tool-ui-action approve with picker:directory, calls handleDipPickerAction (standalone)', async () => {
    const { handleDipPickerAction } = await import('../../src/ui/dip.js');

    const container = document.createElement('div');
    container.setAttribute('data-tool-ui-id', 'req-4');
    toolUIHtmlStore.set('req-4', '<div>test</div>');
    host.appendChild(container);

    hydrateToolUI(host, { isExtension: false, onAction: sendToolUIAction });

    const iframe = container.querySelector('iframe')!;
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'tool-ui-action',
          id: 'req-4',
          action: 'approve',
          picker: 'directory',
          nonce: '',
        },
      })
    );

    // Flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(handleDipPickerAction).toHaveBeenCalled();
    expect(actions[0]).toMatchObject({ requestId: 'req-4', action: 'approve' });
  });
});
