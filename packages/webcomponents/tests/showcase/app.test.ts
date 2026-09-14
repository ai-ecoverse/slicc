import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Collapsed, FreezerPreview, ScoopPreview } from '../../src/showcase/app.stories.js';
import type { SliccAgentAvatar } from '../../src/switcher/slicc-agent-avatar.js';
import type { SliccAgentTabs } from '../../src/switcher/slicc-agent-tabs.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

function renderShowcase(): HTMLElement {
  const render = Collapsed.render as () => HTMLElement;
  const frame = render();
  document.body.appendChild(frame);
  return frame;
}

function renderStory(story: { render?: unknown }): HTMLElement {
  const frame = (story.render as () => HTMLElement)();
  document.body.appendChild(frame);
  return frame;
}

function agentTab(frame: HTMLElement, label: string): HTMLButtonElement {
  return frame.querySelector(`[role="tab"][aria-label^="${label}:"]`) as HTMLButtonElement;
}

function focusedAvatar(frame: HTMLElement): SliccAgentAvatar {
  return frame.querySelector(
    'slicc-agent-tabs > slicc-agent-avatar[part="avatar"]'
  ) as SliccAgentAvatar;
}

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

    expect(shaderOf(frame).getAttribute('mode')).toBe('scoop');
    expect(shaderOf(frame).getAttribute('tint')).toBe(RESEARCHER);

    expect(getComputedStyle(tintOf(frame)).backgroundColor).toBe(resolveColor(RESEARCHER));
    expect(frame.style.getPropertyValue('--ctx').trim()).toBe(RESEARCHER);

    expect(getComputedStyle(composerOf(frame)).display).toBe('none');

    expect(frame.querySelector('slicc-chat-thread[data-scoop="researcher"]')).toBeTruthy();

    expect(agentTab(frame, 'researcher').getAttribute('aria-selected')).toBe('true');
  });

  it('enters freezer-preview when a frozen session card is clicked', () => {
    frame = renderShowcase();
    const card = frame.querySelector('slicc-freezer-card[slug="hero"]') as HTMLElement;
    click(card);

    expect(shaderOf(frame).getAttribute('mode')).toBe('freezer');
    expect(getComputedStyle(tintOf(frame)).backgroundColor).toBe(resolveColor(FREEZER_TINT));
    expect(frame.style.getPropertyValue('--ctx').trim()).toBe(FREEZER_TINT);

    expect(freezerOf(frame).hasAttribute('ctx')).toBe(true);

    expect(getComputedStyle(composerOf(frame)).display).toBe('none');

    expect(frame.querySelector('slicc-chat-thread[data-frozen="hero"]')).toBeTruthy();
    expect(agentTab(frame, 'researcher').getAttribute('aria-selected')).toBe('false');
  });

  it('returns to the live state when the cone tab is clicked', () => {
    frame = renderShowcase();
    click(agentTab(frame, 'researcher'));

    expect(frame.getAttribute('data-preview')).toBe('scoop');

    click(agentTab(frame, 'Sliccy'));

    expect(frame.hasAttribute('data-preview')).toBe(false);
    expect(shaderOf(frame).getAttribute('mode')).toBe('cone');

    expect(tintOf(frame).style.opacity).toBe('0');
    expect(frame.style.getPropertyValue('--ctx').trim()).toBe('');

    expect(getComputedStyle(composerOf(frame)).display).not.toBe('none');
    const thread = frame.querySelector('slicc-chatpane > slicc-chat-thread') as HTMLElement;
    expect(thread.getAttribute('context')).toBe('cone');
    expect(thread.hasAttribute('data-scoop')).toBe(false);
    expect(thread.hasAttribute('data-frozen')).toBe(false);

    expect(frame.querySelector('slicc-agent-tabs')?.hasAttribute('active')).toBe(false);
    expect(agentTab(frame, 'Sliccy').getAttribute('aria-selected')).toBe('true');
  });

  it('renders the edit action-row icon as the pencil glyph, not the literal name', () => {
    frame = renderShowcase();
    const chip = frame.querySelector('slicc-action-row [part="icon"]') as HTMLElement;
    expect(chip).toBeTruthy();

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
