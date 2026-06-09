import { beforeEach, describe, expect, it } from 'vitest';
import { SliccSendButton } from '../../src/primitives/slicc-send-button.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(): SliccSendButton {
  const el = document.createElement('slicc-send-button');
  document.body.appendChild(el);
  return el;
}

describe('slicc-send-button', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-send-button')).toBe(SliccSendButton);
  });

  it('renders a circular button with the up-arrow glyph in its shadow root', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button.send');
    expect(button).not.toBeNull();
    expect(el.shadowRoot?.querySelector('[part="glyph"]')?.textContent).toBe('↑');
  });

  // --- attribute ↔ property reflection ---

  it('reflects the disabled property to the attribute and back', () => {
    const el = mount();
    expect(el.disabled).toBe(false);
    el.disabled = true;
    expect(el.hasAttribute('disabled')).toBe(true);
    el.disabled = false;
    expect(el.hasAttribute('disabled')).toBe(false);

    el.setAttribute('disabled', '');
    expect(el.disabled).toBe(true);
  });

  it('reflects the busy property to the attribute and back', () => {
    const el = mount();
    expect(el.busy).toBe(false);
    el.busy = true;
    expect(el.hasAttribute('busy')).toBe(true);
    el.busy = false;
    expect(el.hasAttribute('busy')).toBe(false);

    el.setAttribute('busy', '');
    expect(el.busy).toBe(true);
  });

  it('reflects the label property to the attribute and back', () => {
    const el = mount();
    expect(el.label).toBeNull();
    el.label = 'Ship it';
    expect(el.getAttribute('label')).toBe('Ship it');
    el.label = null;
    expect(el.hasAttribute('label')).toBe(false);
  });

  // --- variants / states ---

  it('default: enabled button labelled "Send"', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Send');
    expect(button.getAttribute('title')).toBe('Send');
  });

  it('disabled: the inner button is disabled', () => {
    const el = mount();
    el.disabled = true;
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('busy: renders a stop square instead of the arrow and labels "Stop"', () => {
    const el = mount();
    el.busy = true;
    expect(el.shadowRoot?.querySelector('[part="glyph"]')).toBeNull();
    const stop = el.shadowRoot?.querySelector('[part="stop"]');
    expect(stop).not.toBeNull();
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Stop');
  });

  it('honors a custom label over the state default', () => {
    const el = mount();
    el.label = 'Send message';
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Send message');
  });

  it('escapes the label attribute', () => {
    const el = mount();
    el.label = '"><img src=x>';
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    // The whole hostile string survives as a single attribute value — no injection.
    expect(button.getAttribute('aria-label')).toBe('"><img src=x>');
    expect(el.shadowRoot?.querySelector('img')).toBeNull();
  });

  // --- behavior / events ---

  it('emits a composed, bubbling `send` event on click in the default state', () => {
    const el = mount();
    let count = 0;
    let composed = false;
    el.addEventListener('send', (e) => {
      count++;
      composed = e.composed;
    });
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    expect(count).toBe(1);
    expect(composed).toBe(true);
  });

  it('emits `stop` (not `send`) on click while busy', () => {
    const el = mount();
    el.busy = true;
    let send = 0;
    let stop = 0;
    el.addEventListener('send', () => send++);
    el.addEventListener('stop', () => stop++);
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    expect(send).toBe(0);
    expect(stop).toBe(1);
  });

  it('emits nothing when disabled', () => {
    const el = mount();
    el.disabled = true;
    let fired = 0;
    el.addEventListener('send', () => fired++);
    el.addEventListener('stop', () => fired++);
    // Dispatch a raw click — a disabled <button> won't normally fire, so go
    // straight to the click() path the guard protects.
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true })
    );
    expect(fired).toBe(0);
  });

  // --- real-browser appearance fidelity ---

  it('is a 36px circle filled with the rainbow gradient', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button.send') as HTMLButtonElement;
    const cs = getComputedStyle(button);
    expect(cs.width).toBe('36px');
    expect(cs.height).toBe('36px');
    // border-radius 9999px clamps to a full circle.
    expect(parseFloat(cs.borderTopLeftRadius)).toBeGreaterThanOrEqual(18);
    expect(cs.backgroundImage).toContain('gradient');
    // White glyph reads in both themes.
    expect(cs.color).toBe('rgb(255, 255, 255)');
  });

  it('keeps the 36px circle and gradient in dark mode', () => {
    document.body.classList.add('dark');
    try {
      const el = mount();
      const button = el.shadowRoot?.querySelector('button.send') as HTMLButtonElement;
      const cs = getComputedStyle(button);
      expect(cs.width).toBe('36px');
      expect(cs.backgroundImage).toContain('gradient');
      expect(cs.color).toBe('rgb(255, 255, 255)');
    } finally {
      document.body.classList.remove('dark');
    }
  });
});
