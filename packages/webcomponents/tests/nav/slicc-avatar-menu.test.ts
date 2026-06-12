import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccAvatarMenu } from '../../src/nav/slicc-avatar-menu.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccAvatarMenu) => void): SliccAvatarMenu {
  const el = document.createElement('slicc-avatar-menu') as SliccAvatarMenu;
  const trigger = document.createElement('span');
  trigger.textContent = 'PM';
  el.append(trigger);
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

const ITEMS = [
  { id: 'settings', label: 'Account settings…', icon: 'settings' },
  { kind: 'caption' as const, label: 'Helper text.' },
  { kind: 'separator' as const },
  { id: 'signout', label: 'Sign out', icon: 'log-out', danger: true },
];

describe('slicc-avatar-menu', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-avatar-menu')).toBe(SliccAvatarMenu);
  });

  it('renders a trigger button wrapping the default slot', () => {
    const el = mount();
    const trigger = el.shadowRoot?.querySelector('button.trigger[part="trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.querySelector('slot')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.pop[part="popover"]')).not.toBeNull();
  });

  it('keeps its CSS in a constructable adopted stylesheet (no <style> node)', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('style')).toBeNull();
    expect((el.shadowRoot as ShadowRoot).adoptedStyleSheets.length).toBe(1);
  });

  it('is closed by default and opens on trigger click', () => {
    const el = mount();
    expect(el.open).toBe(false);
    (el.shadowRoot?.querySelector('button.trigger') as HTMLButtonElement).click();
    expect(el.open).toBe(true);
    expect(el.shadowRoot?.querySelector('.trigger')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('toggles open/closed with show/hide/toggle and reflects the attribute', () => {
    const el = mount();
    el.show();
    expect(el.hasAttribute('open')).toBe(true);
    el.hide();
    expect(el.hasAttribute('open')).toBe(false);
    el.toggle();
    expect(el.open).toBe(true);
    el.toggle();
    expect(el.open).toBe(false);
  });

  it('emits slicc-avatar-menu-toggle on open and close', () => {
    const el = mount();
    const events: boolean[] = [];
    el.addEventListener('slicc-avatar-menu-toggle', (e) =>
      events.push((e as CustomEvent<{ open: boolean }>).detail.open)
    );
    el.show();
    el.hide();
    expect(events).toEqual([true, false]);
  });

  it('renders the signed-in user header (name + provider)', () => {
    const el = mount((m) => {
      m.user = { name: 'Lars Trieloff', provider: 'Anthropic' };
    });
    expect(el.shadowRoot?.querySelector('.user .name')?.textContent).toBe('Lars Trieloff');
    expect(el.shadowRoot?.querySelector('.user .prov')?.textContent).toBe('Anthropic');
  });

  it('omits the user header when user is null', () => {
    const el = mount((m) => {
      m.user = null;
    });
    expect(el.shadowRoot?.querySelector('.user')).toBeNull();
  });

  it('renders items, separators, and captions from the items property', () => {
    const el = mount((m) => {
      m.items = ITEMS;
    });
    const pop = el.shadowRoot?.querySelector('.pop') as HTMLElement;
    expect(pop.querySelectorAll('button.item').length).toBe(2);
    expect(pop.querySelector('.sep[role="separator"]')).not.toBeNull();
    expect(pop.querySelector('.cap')?.textContent).toBe('Helper text.');
  });

  it('renders item icons as lucide <svg> (never emoji)', () => {
    const el = mount((m) => {
      m.items = ITEMS;
    });
    const icon = el.shadowRoot?.querySelector('button.item .ic svg');
    expect(icon).toBeInstanceOf(SVGSVGElement);
    // No emoji/bespoke glyph survives in the rendered text (icons are lucide svgs).
    expect(el.shadowRoot?.textContent ?? '').not.toMatch(/⚙️|🚪|✦|🔔/u);
  });

  it('marks danger items with the danger class', () => {
    const el = mount((m) => {
      m.items = ITEMS;
    });
    const danger = el.shadowRoot?.querySelector('button.item.danger');
    expect(danger?.textContent).toContain('Sign out');
  });

  it('emits slicc-avatar-action with the id and closes on item click', () => {
    const el = mount((m) => {
      m.items = ITEMS;
      m.show();
    });
    const fired: string[] = [];
    el.addEventListener('slicc-avatar-action', (e) =>
      fired.push((e as CustomEvent<{ id: string }>).detail.id)
    );
    const settings = el.shadowRoot?.querySelector(
      'button.item[data-id="settings"]'
    ) as HTMLButtonElement;
    settings.click();
    expect(fired).toEqual(['settings']);
    expect(el.open).toBe(false);
  });

  it('does not fire an action for a disabled item', () => {
    const el = mount((m) => {
      m.items = [{ id: 'pending', label: 'Connecting…', disabled: true }];
      m.show();
    });
    const handler = vi.fn();
    el.addEventListener('slicc-avatar-action', handler);
    const item = el.shadowRoot?.querySelector('button.item') as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    item.click();
    expect(handler).not.toHaveBeenCalled();
  });

  it('closes on an outside mousedown', () => {
    const el = mount((m) => m.show());
    expect(el.open).toBe(true);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    expect(el.open).toBe(false);
  });

  it('stays open for a mousedown inside the menu', () => {
    const el = mount((m) => {
      m.items = ITEMS;
      m.show();
    });
    el.shadowRoot
      ?.querySelector('.pop')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    expect(el.open).toBe(true);
  });

  it('closes on Escape', () => {
    const el = mount((m) => m.show());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(el.open).toBe(false);
  });

  it('returns a defensive copy from the items getter', () => {
    const el = mount((m) => {
      m.items = ITEMS;
    });
    el.items[0].label = 'mutated';
    expect(el.items[0].label).toBe('Account settings…');
  });

  it('the popover is a 220px+ panel anchored under the trigger (real Chromium)', () => {
    const el = mount((m) => m.show());
    const pop = el.shadowRoot?.querySelector('.pop') as HTMLElement;
    const cs = getComputedStyle(pop);
    expect(cs.position).toBe('absolute');
    expect(Number.parseFloat(cs.minWidth)).toBeGreaterThanOrEqual(220);
  });
});
