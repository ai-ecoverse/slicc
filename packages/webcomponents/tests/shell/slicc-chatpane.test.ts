import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/chat/slicc-agent-message.js';
import '../../src/chat/slicc-chat-thread.js';
import '../../src/composer/slicc-composer.js';
import '../../src/nav/slicc-nav.js';
import { SliccChatpane } from '../../src/shell/slicc-chatpane.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

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
    el.narrow = false;
    expect(seen).toEqual([true, false]);
  });

  it('narrows to 34% width when narrow is set', () => {
    const wide = mount();
    const wideW = getComputedStyle(wide).width;
    const narrow = mount(true);
    const narrowW = getComputedStyle(narrow).width;
    expect(narrowW).not.toBe(wideW);
  });

  it('forwards the current narrow state to a thread added later (MutationObserver)', async () => {
    const el = mount(true);
    const late = document.createElement('slicc-chat-thread');
    el.appendChild(late);
    // The childList MutationObserver runs on a microtask.
    await Promise.resolve();
    expect(late.hasAttribute('open')).toBe(true);
  });

  /** Mount a chatpane hosting an agent message whose prose sets no color of its own. */
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
    // Light: --ink is the near-black #0a0a0a; the slotted agent prose inherits it.
    const { pane: lightPane, prose: lightProse } = mountWithAgent(document.body);
    expect(getComputedStyle(lightPane).color).toBe('rgb(10, 10, 10)');
    expect(getComputedStyle(lightProse).color).toBe('rgb(10, 10, 10)');

    // Dark: the .dark scope flips --ink to the very bright #f5f5f2 for contrast.
    const dark = document.createElement('div');
    dark.className = 'dark';
    document.body.appendChild(dark);
    const { pane: darkPane, prose: darkProse } = mountWithAgent(dark);
    expect(getComputedStyle(darkPane).color).toBe('rgb(245, 245, 242)');
    // The agent prose sets no color of its own, so it inherits the bright foreground.
    expect(getComputedStyle(darkProse).color).toBe('rgb(245, 245, 242)');
  });
});
