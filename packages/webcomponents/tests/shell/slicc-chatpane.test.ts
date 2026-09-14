import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/chat/slicc-agent-message.js';
import '../../src/chat/slicc-chat-thread.js';
import '../../src/composer/slicc-composer.js';
import '../../src/nav/slicc-nav.js';
import { SliccChatpane } from '../../src/shell/slicc-chatpane.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function alphaOf(color: string): number {
  const rgba = color.match(/rgba?\(([^)]+)\)/);
  if (rgba) {
    const parts = rgba[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length >= 4 ? Number.parseFloat(parts[3]) : 1;
  }
  const fn = color.match(/color\([^/]*\/\s*([0-9.]+)\s*\)/);
  if (fn) return Number.parseFloat(fn[1]);
  return 1;
}

function mount(narrow = false): SliccChatpane {
  const el = document.createElement('slicc-chatpane');
  if (narrow) el.setAttribute('narrow', '');
  el.innerHTML =
    '<slicc-nav></slicc-nav>' +
    '<slicc-chat-thread></slicc-chat-thread>' +
    '<slicc-composer></slicc-composer>';
  document.body.appendChild(el);
  return el as SliccChatpane;
}

describe('slicc-chatpane', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });
  afterEach(() => document.body.replaceChildren());

  it('registers and is a light-DOM column carrying part="pane"', () => {
    expect(customElements.get('slicc-chatpane')).toBe(SliccChatpane);
    const el = mount();
    expect(el.shadowRoot).toBeNull();
    expect(el.getAttribute('part')).toBe('pane');
    expect(getComputedStyle(el).flexDirection).toBe('column');
  });

  it('exposes the slotted nav/thread/composer by getter', () => {
    const el = mount();
    expect(el.nav?.tagName.toLowerCase()).toBe('slicc-nav');
    expect(el.thread?.tagName.toLowerCase()).toBe('slicc-chat-thread');
    expect(el.composer?.tagName.toLowerCase()).toBe('slicc-composer');
  });

  it('forwards narrow to the thread + composer as their open attribute', () => {
    const el = mount();
    expect(el.thread?.hasAttribute('open')).toBe(false);
    el.narrow = true;
    expect(el.hasAttribute('narrow')).toBe(true);
    expect(el.thread?.hasAttribute('open')).toBe(true);
    expect(el.composer?.hasAttribute('open')).toBe(true);
    el.narrow = false;
    expect(el.thread?.hasAttribute('open')).toBe(false);
    expect(el.composer?.hasAttribute('open')).toBe(false);
  });

  it('emits slicc-chatpane-narrow-change on toggle', () => {
    const el = mount();
    const seen: boolean[] = [];
    el.addEventListener('slicc-chatpane-narrow-change', (e) =>
      seen.push((e as CustomEvent).detail.narrow)
    );
    el.narrow = true;
    expect(seen).toEqual([true]);
    el.narrow = false;
    expect(seen).toEqual([true, false]);
  });

  it('keeps the container-filling width when narrow is set — the dock-tree leaf owns column width', () => {
    const wide = mount();
    const wideW = wide.getBoundingClientRect().width;
    const narrow = mount(true);
    const narrowW = narrow.getBoundingClientRect().width;
    expect(narrowW).toBeCloseTo(wideW, 1);

    expect(getComputedStyle(wide).flexGrow).toBe('1');
    expect(wideW).toBeCloseTo(wide.parentElement!.getBoundingClientRect().width, 1);
  });

  it('narrow (workbench open, wide viewport): drops the frosted card but KEEPS the centered reading cap', () => {
    const el = mount(true);
    const thread = el.thread as HTMLElement;
    const inner = thread.querySelector('.slicc-thread__inner') as HTMLElement;
    expect(inner).not.toBeNull();

    const cs = getComputedStyle(inner);

    expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(cs.maskImage).toBe('none');
    expect(cs.borderTopLeftRadius).toBe('0px');

    expect(cs.maxWidth).toBe('776px');
    expect(cs.marginLeft).toBe(cs.marginRight);
  });

  it('narrow: the thread inner is at least the full viewport tall so a short history fills to the bottom', () => {
    const el = mount(true);
    const thread = el.thread as HTMLElement;
    const inner = thread.querySelector('.slicc-thread__inner') as HTMLElement;
    expect(inner).not.toBeNull();

    const cs = getComputedStyle(inner);

    const minH = Number.parseFloat(cs.minHeight);
    expect(minH).toBeCloseTo(window.innerHeight, 0);

    expect(inner.getBoundingClientRect().height).toBeGreaterThanOrEqual(window.innerHeight - 0.5);
  });

  it('wide: the thread inner is background-free — prose sits directly on the shader field', () => {
    const el = mount(false);
    const thread = el.thread as HTMLElement;
    const inner = thread.querySelector('.slicc-thread__inner') as HTMLElement;
    const cs = getComputedStyle(inner);

    expect(cs.maxWidth).toBe('776px');

    expect(alphaOf(cs.backgroundColor)).toBe(0);

    expect(cs.color).toBe('rgb(10, 10, 10)');
  });

  it('forwards the current narrow state to a thread added later (MutationObserver)', async () => {
    const el = mount(true);
    const late = document.createElement('slicc-chat-thread');
    el.appendChild(late);

    await Promise.resolve();
    expect(late.hasAttribute('open')).toBe(true);
  });

  function mountWithAgent(scope: HTMLElement): { pane: SliccChatpane; prose: HTMLElement } {
    const pane = document.createElement('slicc-chatpane') as SliccChatpane;
    const msg = document.createElement('slicc-agent-message');
    const prose = document.createElement('p');
    prose.textContent = 'On it — wiring the frost shader into the freezer rail now.';
    msg.appendChild(prose);
    pane.appendChild(msg);
    scope.appendChild(pane);
    return { pane, prose };
  }

  it('establishes the bright --ink foreground in dark mode (dark --ink in light mode)', () => {
    const { pane: lightPane, prose: lightProse } = mountWithAgent(document.body);
    expect(getComputedStyle(lightPane).color).toBe('rgb(10, 10, 10)');
    expect(getComputedStyle(lightProse).color).toBe('rgb(10, 10, 10)');

    const dark = document.createElement('div');
    dark.className = 'dark';
    document.body.appendChild(dark);
    const { pane: darkPane, prose: darkProse } = mountWithAgent(dark);
    expect(getComputedStyle(darkPane).color).toBe('rgb(245, 245, 242)');

    expect(getComputedStyle(darkProse).color).toBe('rgb(245, 245, 242)');
  });
});
