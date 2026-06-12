import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccDialog } from '../../src/overlay/slicc-dialog.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccDialog) => void): SliccDialog {
  const el = document.createElement('slicc-dialog') as SliccDialog;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

describe('slicc-dialog', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-dialog')).toBe(SliccDialog);
  });

  it('builds the overlay + dialog shell with parts', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('.overlay[part="overlay"]')).not.toBeNull();
    const dialog = el.shadowRoot?.querySelector('.dialog[part="dialog"]');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
  });

  it('keeps its CSS in a constructable adopted stylesheet (no <style> node)', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('style')).toBeNull();
    expect((el.shadowRoot as ShadowRoot).adoptedStyleSheets.length).toBe(1);
  });

  it('is hidden until open (the host display flips with the attribute)', () => {
    const el = mount();
    expect(getComputedStyle(el).display).toBe('none');
    el.show();
    expect(el.hasAttribute('open')).toBe(true);
    expect(getComputedStyle(el).display).toBe('block');
  });

  it('reflects heading + description into the shell and back', () => {
    const el = mount((d) => {
      d.heading = 'Add account';
      d.description = 'Connect a provider.';
    });
    expect(el.getAttribute('heading')).toBe('Add account');
    expect(el.shadowRoot?.querySelector('.title')?.textContent).toBe('Add account');
    expect(el.shadowRoot?.querySelector('.desc')?.textContent).toBe('Connect a provider.');
    el.heading = null;
    expect(el.hasAttribute('heading')).toBe(false);
    expect((el.shadowRoot?.querySelector('.title') as HTMLElement).style.display).toBe('none');
  });

  it('uses heading (not title) so it does not collide with the native tooltip attr', () => {
    const el = mount((d) => {
      d.heading = 'Hi';
    });
    expect(el.hasAttribute('title')).toBe(false);
  });

  it('renders a default body slot and a named footer slot', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('.body slot:not([name])')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.footer slot[name="footer"]')).not.toBeNull();
  });

  it('renders a lucide ✕ close button (hidden via no-close-button)', () => {
    const el = mount();
    const x = el.shadowRoot?.querySelector('.x[part="close"]');
    expect(x?.querySelector('svg')).toBeInstanceOf(SVGSVGElement);
    el.setAttribute('no-close-button', '');
    expect((el.shadowRoot?.querySelector('.x') as HTMLElement).style.display).toBe('none');
  });

  it('closes with reason "close-button" when ✕ is clicked', () => {
    const el = mount((d) => d.show());
    const reasons: string[] = [];
    el.addEventListener('slicc-dialog-close', (e) =>
      reasons.push((e as CustomEvent<{ reason: string }>).detail.reason)
    );
    (el.shadowRoot?.querySelector('.x') as HTMLButtonElement).click();
    expect(el.open).toBe(false);
    expect(reasons).toEqual(['close-button']);
  });

  it('closes with reason "backdrop" on a backdrop mousedown', () => {
    const el = mount((d) => d.show());
    const reasons: string[] = [];
    el.addEventListener('slicc-dialog-close', (e) =>
      reasons.push((e as CustomEvent<{ reason: string }>).detail.reason)
    );
    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(reasons).toEqual(['backdrop']);
  });

  it('does NOT close on a mousedown that lands on the dialog card', () => {
    const el = mount((d) => d.show());
    const handler = vi.fn();
    el.addEventListener('slicc-dialog-close', handler);
    (el.shadowRoot?.querySelector('.dialog') as HTMLElement).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true })
    );
    expect(handler).not.toHaveBeenCalled();
    expect(el.open).toBe(true);
  });

  it('persistent ignores backdrop clicks (Escape / ✕ still close)', () => {
    const el = mount((d) => {
      d.persistent = true;
      d.show();
    });
    expect(el.hasAttribute('persistent')).toBe(true);
    (el.shadowRoot?.querySelector('.overlay') as HTMLElement).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true })
    );
    expect(el.open).toBe(true);
    (el.shadowRoot?.querySelector('.x') as HTMLButtonElement).click();
    expect(el.open).toBe(false);
  });

  it('closes with reason "escape" on the Escape key while open', () => {
    const el = mount((d) => d.show());
    const reasons: string[] = [];
    el.addEventListener('slicc-dialog-close', (e) =>
      reasons.push((e as CustomEvent<{ reason: string }>).detail.reason)
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(reasons).toEqual(['escape']);
    expect(el.open).toBe(false);
  });

  it('hide() closes with reason "api"', () => {
    const el = mount((d) => d.show());
    const reasons: string[] = [];
    el.addEventListener('slicc-dialog-close', (e) =>
      reasons.push((e as CustomEvent<{ reason: string }>).detail.reason)
    );
    el.hide();
    expect(reasons).toEqual(['api']);
  });

  it('is a centered 440px-max card behind a blurred backdrop (real Chromium)', () => {
    const el = mount((d) => d.show());
    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    const dialog = el.shadowRoot?.querySelector('.dialog') as HTMLElement;
    const oc = getComputedStyle(overlay);
    expect(oc.position).toBe('fixed');
    expect(oc.justifyContent).toBe('center');
    expect(oc.alignItems).toBe('center');
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(440);
  });
});
