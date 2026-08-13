import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The full-app showcase story assembles the whole surface; importing it
// registers every element it composes (agent tabs included).
import { Collapsed, FreezerPreview, ScoopPreview } from '../../src/showcase/app.stories.js';
import type { SliccAgentAvatar } from '../../src/switcher/slicc-agent-avatar.js';
import type { SliccAgentTabs } from '../../src/switcher/slicc-agent-tabs.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

/** Render the showcase `Collapsed` story into the document and return its frame. */
function renderShowcase(): HTMLElement {
  const render = Collapsed.render as () => HTMLElement;
  const frame = render();
  document.body.appendChild(frame);
  return frame;
}

/** Render an arbitrary showcase story into the document and return its frame. */
function renderStory(story: { render?: unknown }): HTMLElement {
  const frame = (story.render as () => HTMLElement)();
  document.body.appendChild(frame);
  return frame;
}

/** An agent tab resolved by its accessible label rather than its styling classes. */
function agentTab(frame: HTMLElement, label: string): HTMLButtonElement {
  return frame.querySelector(`[role="tab"][aria-label^="${label}:"]`) as HTMLButtonElement;
}

/** The focused-agent avatar exposed by the tabs' public `avatar` part. */
function focusedAvatar(frame: HTMLElement): SliccAgentAvatar {
  return frame.querySelector(
    'slicc-agent-tabs > slicc-agent-avatar[part="avatar"]'
  ) as SliccAgentAvatar;
}

/** Resolve a CSS color (e.g. a hex token) to its computed `rgb(...)` form. */
function resolveColor(css: string): string {
  const probe = document.createElement('span');
  probe.style.color = css;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  return rgb;
}

const FREEZER_TINT = '#3b6cb2';
const RESEARCHER = '#06b6d4';

describe('showcase full-app agent tabs', () => {
  let frame: HTMLElement | null = null;

  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  afterEach(() => {
    frame?.remove();
    frame = null;
  });

  it('renders the cone tab and focused cone avatar in the nav', () => {
    frame = renderShowcase();
    expect(agentTab(frame, 'Sliccy')).toBeTruthy();
    expect(focusedAvatar(frame).getAttribute('type')).toBe('cone');
  });

  it('selects the cone as the fallback without setting an explicit active tab', () => {
    frame = renderShowcase();
    const tabs = frame.querySelector('slicc-agent-tabs') as HTMLElement;
    expect(tabs.hasAttribute('active')).toBe(false);
    expect(agentTab(frame, 'Sliccy').getAttribute('aria-selected')).toBe('true');
  });

  it('shows a neutral selected background instead of the cone accent fill', () => {
    frame = renderShowcase();
    const cs = getComputedStyle(agentTab(frame, 'Sliccy'));
    // The selected segment sits on the canvas surface rather than taking the
    // scoop accent as a fill.
    const canvas = cs.getPropertyValue('--canvas').trim();
    expect(canvas === '' || resolveColor(canvas) === 'rgba(0, 0, 0, 0)').toBe(false);
    expect(cs.backgroundColor).toBe(resolveColor(canvas));
  });

  it('keeps dark (non-inverted) label text rather than the white-on-fill label', () => {
    frame = renderShowcase();
    expect(getComputedStyle(agentTab(frame, 'Sliccy')).color).not.toBe('rgb(255, 255, 255)');
  });

  it('keeps the cone eyes alive: it moves its own gaze, and a tool call follows the cursor', async () => {
    frame = renderShowcase();
    const cone = focusedAvatar(frame);
    expect(cone.getAttribute('eyes')).toBe('open');
    // Off a tool call the avatar owns its gaze — saccades while thinking, a lazy
    // wander while idle — and ignores the pointer entirely.
    expect(['idle', 'thinking']).toContain(cone.getAttribute('activity'));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    expect(cone.shadowRoot?.querySelector('.pupil-l')?.getAttribute('transform')).toMatch(
      /^translate\(/
    );

    const tabs = frame.querySelector('slicc-agent-tabs') as SliccAgentTabs;
    tabs.scoops = tabs.scoops.map((scoop) => ({ ...scoop, state: 'working', phase: 'tool' }));
    const svg = cone.shadowRoot?.querySelector('.eyes-svg') as SVGElement;
    expect(svg).toBeTruthy();
    const r = svg.getBoundingClientRect();
    document.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: r.left + r.width + 500,
        clientY: r.top + r.height + 500,
      })
    );
    const left = cone.shadowRoot?.querySelector('.pupil-l') as SVGGElement;
    const right = cone.shadowRoot?.querySelector('.pupil-r') as SVGGElement;
    expect(left.getAttribute('transform')).toMatch(/^translate\(/);
    expect(right.getAttribute('transform')).toMatch(/^translate\(/);
  });
});

describe('showcase full-app preview states', () => {
  let frame: HTMLElement | null = null;

  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  afterEach(() => {
    frame?.remove();
    frame = null;
  });

  const shaderOf = (f: HTMLElement) => f.querySelector('slicc-shader') as HTMLElement;
  const composerOf = (f: HTMLElement) => f.querySelector('slicc-composer') as HTMLElement;
  const tintOf = (f: HTMLElement) => f.querySelector('.sc-tint') as HTMLElement;
  const freezerOf = (f: HTMLElement) => f.querySelector('slicc-freezer') as HTMLElement;
  const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  it('enters scoop-preview when a scoop tab is clicked', () => {
    frame = renderShowcase();
    click(agentTab(frame, 'researcher'));

    // Swirl ("scoop") shader, tinted to the scoop's primary color.
    expect(shaderOf(frame).getAttribute('mode')).toBe('scoop');
    expect(shaderOf(frame).getAttribute('tint')).toBe(RESEARCHER);
    // The whole-surface wash carries the scoop color.
    expect(getComputedStyle(tintOf(frame)).backgroundColor).toBe(resolveColor(RESEARCHER));
    expect(frame.style.getPropertyValue('--ctx').trim()).toBe(RESEARCHER);
    // The composer is hidden — the conversation is driven by the cone.
    expect(getComputedStyle(composerOf(frame)).display).toBe('none');
    // The scoop's own history thread replaced the cone thread.
    expect(frame.querySelector('slicc-chat-thread[data-scoop="researcher"]')).toBeTruthy();
    // The scoop tab reads as selected.
    expect(agentTab(frame, 'researcher').getAttribute('aria-selected')).toBe('true');
  });

  it('enters freezer-preview when a frozen session card is clicked', () => {
    frame = renderShowcase();
    const card = frame.querySelector('slicc-freezer-card[slug="hero"]') as HTMLElement;
    click(card);

    // Frost ("freezer") shader + ice-blue wash.
    expect(shaderOf(frame).getAttribute('mode')).toBe('freezer');
    expect(getComputedStyle(tintOf(frame)).backgroundColor).toBe(resolveColor(FREEZER_TINT));
    expect(frame.style.getPropertyValue('--ctx').trim()).toBe(FREEZER_TINT);
    // The freezer chrome takes its ice-blue context accent.
    expect(freezerOf(frame).hasAttribute('ctx')).toBe(true);
    // The composer is hidden — the session is frozen.
    expect(getComputedStyle(composerOf(frame)).display).toBe('none');
    // The frozen conversation loaded; no scoop tab is selected.
    expect(frame.querySelector('slicc-chat-thread[data-frozen="hero"]')).toBeTruthy();
    expect(agentTab(frame, 'researcher').getAttribute('aria-selected')).toBe('false');
  });

  it('returns to the live state when the cone tab is clicked', () => {
    frame = renderShowcase();
    click(agentTab(frame, 'researcher'));
    // Sanity: we are in a preview before returning.
    expect(frame.getAttribute('data-preview')).toBe('scoop');

    click(agentTab(frame, 'Sliccy'));

    expect(frame.hasAttribute('data-preview')).toBe(false);
    expect(shaderOf(frame).getAttribute('mode')).toBe('cone');
    // The wash fades out and the context override is cleared.
    expect(tintOf(frame).style.opacity).toBe('0');
    expect(frame.style.getPropertyValue('--ctx').trim()).toBe('');
    // The composer is visible again and the live cone thread is restored.
    expect(getComputedStyle(composerOf(frame)).display).not.toBe('none');
    const thread = frame.querySelector('slicc-chatpane > slicc-chat-thread') as HTMLElement;
    expect(thread.getAttribute('context')).toBe('cone');
    expect(thread.hasAttribute('data-scoop')).toBe(false);
    expect(thread.hasAttribute('data-frozen')).toBe(false);
    // The cone is the selected fallback without an explicit active tab.
    expect(frame.querySelector('slicc-agent-tabs')?.hasAttribute('active')).toBe(false);
    expect(agentTab(frame, 'Sliccy').getAttribute('aria-selected')).toBe('true');
  });

  it('renders the edit action-row icon as the pencil glyph, not the literal name', () => {
    frame = renderShowcase();
    const chip = frame.querySelector('slicc-action-row [part="icon"]') as HTMLElement;
    expect(chip).toBeTruthy();
    // Regression: the showcase once passed the lucide name 'pencil' to the
    // action-row's glyph-character `icon` attribute, leaking the raw string into
    // the chip. It must render the pencil glyph instead.
    expect(chip.textContent).toBe('✎');
    expect(chip.textContent).not.toBe('pencil');
  });

  it('renders the ScoopPreview story already in scoop-preview', () => {
    frame = renderStory(ScoopPreview);
    expect(frame.getAttribute('data-preview')).toBe('scoop');
    expect(shaderOf(frame).getAttribute('mode')).toBe('scoop');
    expect(shaderOf(frame).getAttribute('tint')).toBe(RESEARCHER);
    expect(getComputedStyle(composerOf(frame)).display).toBe('none');
    expect(frame.querySelector('slicc-chat-thread[data-scoop="researcher"]')).toBeTruthy();
  });

  it('renders the FreezerPreview story already in freezer-preview', () => {
    frame = renderStory(FreezerPreview);
    expect(frame.getAttribute('data-preview')).toBe('freezer');
    expect(shaderOf(frame).getAttribute('mode')).toBe('freezer');
    expect(freezerOf(frame).hasAttribute('ctx')).toBe(true);
    expect(getComputedStyle(composerOf(frame)).display).toBe('none');
    expect(frame.querySelector('slicc-chat-thread[data-frozen="hero"]')).toBeTruthy();
  });
});
