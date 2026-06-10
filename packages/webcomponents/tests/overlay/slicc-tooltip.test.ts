import { beforeEach, describe, expect, it } from 'vitest';
import { SliccTooltip } from '../../src/overlay/slicc-tooltip.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(attrs: Record<string, string> = {}): SliccTooltip {
  const el = document.createElement('slicc-tooltip') as SliccTooltip;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  const trigger = document.createElement('button');
  trigger.textContent = '⌗';
  el.append(trigger);
  document.body.appendChild(el);
  return el;
}

describe('slicc-tooltip', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-tooltip')).toBe(SliccTooltip);
  });

  it('renders a trigger slot and a tip pill in a constructable sheet (no <style>)', () => {
    const el = mount({ label: 'Files' });
    expect(el.shadowRoot?.querySelector('slot')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.tip[part="tip"]')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('style')).toBeNull();
    expect((el.shadowRoot as ShadowRoot).adoptedStyleSheets.length).toBe(1);
  });

  it('reflects label into the tip text and back through the property', () => {
    const el = mount({ label: 'Files · VFS' });
    expect(el.shadowRoot?.querySelector('.tip')?.textContent).toBe('Files · VFS');
    el.label = 'Terminal';
    expect(el.shadowRoot?.querySelector('.tip')?.textContent).toBe('Terminal');
    el.label = null;
    expect(el.hasAttribute('label')).toBe(false);
    expect(el.shadowRoot?.querySelector('.tip')?.textContent).toBe('');
  });

  it('defaults to top placement and accepts the four sides', () => {
    const el = mount({ label: 'x' });
    expect(el.placement).toBe('top');
    expect(el.shadowRoot?.querySelector('.tip')?.getAttribute('data-p')).toBe('top');
    for (const p of ['bottom', 'left', 'right'] as const) {
      el.placement = p;
      expect(el.shadowRoot?.querySelector('.tip')?.getAttribute('data-p')).toBe(p);
    }
  });

  it('normalizes an unknown placement to top', () => {
    const el = mount({ label: 'x', placement: 'sideways' });
    expect(el.placement).toBe('top');
  });

  it('is hidden at rest, with a :host(:hover) rule that reveals it', () => {
    const el = mount({ label: 'Files' });
    const tip = el.shadowRoot?.querySelector('.tip') as HTMLElement;
    expect(getComputedStyle(tip).opacity).toBe('0');
    // The reveal is pure CSS — assert the adopted sheet carries the hover rule
    // (a real :hover is environment-driven and flaky to script).
    const sheet = (el.shadowRoot as ShadowRoot).adoptedStyleSheets[0];
    const hasHover = Array.from(sheet.cssRules).some(
      (r) =>
        r instanceof CSSStyleRule && r.selectorText.includes(':hover') && r.style.opacity === '1'
    );
    expect(hasHover).toBe(true);
  });

  it('the open attribute forces the tip visible regardless of hover', () => {
    const el = mount({ label: 'Files', open: '' });
    const tip = el.shadowRoot?.querySelector('.tip') as HTMLElement;
    expect(getComputedStyle(tip).opacity).toBe('1');
  });

  it('renders nothing visible for an empty label (.tip:empty collapses)', () => {
    const el = mount({ open: '' });
    const tip = el.shadowRoot?.querySelector('.tip') as HTMLElement;
    expect(tip.textContent).toBe('');
    expect(getComputedStyle(tip).display).toBe('none');
  });

  it('positions the tip above the trigger for top placement (real Chromium geometry)', () => {
    const el = mount({ label: 'Files', open: '', placement: 'top' });
    const tip = el.shadowRoot?.querySelector('.tip') as HTMLElement;
    const trigger = el.querySelector('button') as HTMLElement;
    expect(tip.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      trigger.getBoundingClientRect().top + 1
    );
  });
});
