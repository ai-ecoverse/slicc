// @vitest-environment jsdom
/**
 * Shell-composition tests for the `?ui=wc` preview mount: structure of the
 * frame (shader / freezer / nav / shell / dock), dock→workbench wiring, and
 * the composer's local echo loop.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { mountWcUiPreview } from '../../../src/ui/wc/wc-shell.js';

function mount(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mountWcUiPreview(root);
  return root;
}

describe('mountWcUiPreview', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.getElementById('slicc-tokens')?.remove();
    document.getElementById('slicc-wcui-style')?.remove();
  });

  it('injects the library token stylesheet and the shell styles once', () => {
    const root = mount();
    expect(document.getElementById('slicc-tokens')).toBeTruthy();
    expect(document.getElementById('slicc-wcui-style')).toBeTruthy();
    mountWcUiPreview(root);
    expect(document.querySelectorAll('#slicc-tokens').length).toBe(1);
    expect(document.querySelectorAll('#slicc-wcui-style').length).toBe(1);
  });

  it('replaces prior root content (idempotent mount)', () => {
    const root = mount();
    mountWcUiPreview(root);
    expect(root.children.length).toBe(1);
  });

  it('assembles nav, freezer, shader, shell, and dock', () => {
    const root = mount();
    const nav = root.querySelector('slicc-nav');
    expect(nav).toBeTruthy();
    for (const tag of [
      'slicc-logo',
      'slicc-scoop-switcher',
      'slicc-floatbar',
      'slicc-theme-toggle',
      'slicc-avatar',
    ]) {
      expect(nav?.querySelector(tag), tag).toBeTruthy();
    }
    expect(root.querySelector('slicc-shader')).toBeTruthy();
    expect(root.querySelector('slicc-freezer slicc-freezer-new')).toBeTruthy();
    expect(root.querySelector('slicc-shell slicc-chatpane')).toBeTruthy();
    expect(root.querySelector('slicc-dock')?.hasAttribute('system-tools')).toBe(true);
  });

  it('populates the cone thread from the chat fixture', () => {
    const root = mount();
    const thread = root.querySelector('slicc-chat-thread');
    expect(thread?.getAttribute('context')).toBe('cone');
    expect(thread?.querySelectorAll('slicc-user-message').length).toBeGreaterThan(2);
    expect(thread?.querySelectorAll('slicc-agent-message').length).toBeGreaterThan(2);
    expect(thread?.querySelectorAll('slicc-lick-card').length).toBeGreaterThan(5);
  });

  it('opens the workbench on dock select and closes on dock collapse', () => {
    const root = mount();
    const dock = root.querySelector('slicc-dock') as HTMLElement;
    const shell = root.querySelector('slicc-shell') as HTMLElement;
    const body = root.querySelector('slicc-workbench-body') as HTMLElement;

    dock.dispatchEvent(
      new CustomEvent('slicc-dock-select', { bubbles: true, detail: { id: 'files' } })
    );
    expect(shell.hasAttribute('open')).toBe(true);
    expect(body.getAttribute('active')).toBe('files');

    // Clicking the active dock item emits `slicc-dock-collapse` (the dock
    // owns toggle semantics) — the workbench must close on it.
    dock.dispatchEvent(new CustomEvent('slicc-dock-collapse', { bubbles: true }));
    expect(shell.hasAttribute('open')).toBe(false);
  });

  it('kills the UA body margin so the frame sits flush', () => {
    mount();
    const css = document.getElementById('slicc-wcui-style')?.textContent ?? '';
    expect(css).toContain('html,body{margin:0');
  });

  it('renders a placeholder for the unwired browser surface', () => {
    const root = mount();
    const surface = root.querySelector('[surface-id="browser"]');
    expect(surface?.textContent).toContain('not wired');
  });

  it('switches the active surface on tab select', () => {
    const root = mount();
    const header = root.querySelector('slicc-workbench-header') as HTMLElement;
    const body = root.querySelector('slicc-workbench-body') as HTMLElement;
    header.dispatchEvent(
      new CustomEvent('tab-select', { bubbles: true, detail: { tabId: 'files' } })
    );
    expect(body.getAttribute('active')).toBe('files');
  });

  it('echoes composer submissions into the thread', () => {
    const root = mount();
    const card = root.querySelector('slicc-input-card') as HTMLElement;
    const thread = root.querySelector('slicc-chat-thread') as HTMLElement;
    const before = thread.querySelectorAll('slicc-user-message').length;

    card.dispatchEvent(
      new CustomEvent('submit', { bubbles: true, detail: { value: 'hello from the preview' } })
    );
    const bubbles = thread.querySelectorAll('slicc-user-message');
    expect(bubbles.length).toBe(before + 1);
    // The bubble body renders into the component's shadow root.
    expect(bubbles[bubbles.length - 1].shadowRoot?.textContent).toContain('hello from the preview');

    card.dispatchEvent(new CustomEvent('submit', { bubbles: true, detail: { value: '   ' } }));
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(before + 1);
  });
});
