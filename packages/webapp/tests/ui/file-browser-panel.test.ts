// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { FileBrowserPanel } from '../../src/ui/file-browser-panel.js';

function createContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('FileBrowserPanel', () => {
  it('registers a keydown listener on the container', () => {
    const container = createContainer();
    const spy = vi.spyOn(container, 'addEventListener');
    new FileBrowserPanel(container);
    expect(spy).toHaveBeenCalledWith('keydown', expect.any(Function));
    container.remove();
  });

  it('removes the keydown listener on dispose', () => {
    const container = createContainer();
    const spy = vi.spyOn(container, 'removeEventListener');
    const panel = new FileBrowserPanel(container);
    panel.dispose();
    expect(spy).toHaveBeenCalledWith('keydown', expect.any(Function));
    container.remove();
  });
});
