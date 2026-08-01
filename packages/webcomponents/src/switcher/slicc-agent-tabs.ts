import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import '../primitives/slicc-googly-eyes.js';

export type AgentState = 'working' | 'broken' | 'initializing' | 'idle';

export interface ScoopDescriptor {
  key: string;
  type?: 'cone' | 'scoop';
  color?: string;
  label?: string;
  eyes?: 'open' | 'none' | 'dead';
  fill?: number;
  ephemeral?: boolean;
  state?: AgentState;
}

export interface ScoopSelectDetail {
  id: string;
  key: string;
  label: string;
}

const PREFIX = 'slicc-agent-tabs';
const STYLE_ID = `${PREFIX}-style`;
const SVG_NS = 'http://www.w3.org/2000/svg';
const ARC_RADIUS = 5;
const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS;
const AVATAR_WIDTH = 26;
const HOST_GAP = 8;
const TRACK_CHROME = 6;
const MORE_RESERVE = 39;

const DATA_K_HUE: Record<string, string> = {
  cone: 'var(--waffle)',
  researcher: 'var(--cyan)',
  designer: 'var(--violet)',
  tester: 'var(--amber)',
  triage: 'var(--green)',
};

const STYLE = `
.slicc-agent-tabs{display:flex;align-items:center;gap:${HOST_GAP}px;min-width:0;overflow:visible;color:var(--ink);font-family:var(--ui);}
.slicc-agent-tabs *{box-sizing:border-box;}
.slicc-agent-tabs__focus-avatar{display:grid;flex:0 0 ${AVATAR_WIDTH}px;width:${AVATAR_WIDTH}px;height:${AVATAR_WIDTH}px;place-items:center;overflow:hidden;color:var(--slicc-agent-tabs-hue);border:1px solid color-mix(in srgb,var(--slicc-agent-tabs-hue) 34%,var(--line));border-radius:7px;background:color-mix(in srgb,var(--slicc-agent-tabs-hue) 18%,var(--canvas));pointer-events:none;}
.slicc-agent-tabs__focus-avatar[data-type='scoop']{border-radius:50%;}
.slicc-agent-tabs__focus-avatar-mark{font:700 11px/1 var(--ui);text-transform:uppercase;}
.slicc-agent-tabs__focus-avatar slicc-googly-eyes{display:block;line-height:0;}
.slicc-agent-tabs__track-frame{position:relative;flex:1 1 auto;min-width:0;height:var(--ctl-h,30px);overflow:visible;border:1px solid var(--line);border-radius:9px;background:var(--ghost);}
.slicc-agent-tabs__track{display:flex;align-items:center;min-width:0;height:100%;padding:2px;overflow:hidden;}
.slicc-agent-tabs.has-overflow .slicc-agent-tabs__track{padding-right:41px;}
.slicc-agent-tabs__segment{position:relative;display:inline-flex;flex:1 0 72px;align-items:center;justify-content:center;gap:5px;min-width:72px;height:24px;padding:0 8px;overflow:hidden;color:var(--txt-2);font:500 11px/1 var(--ui);white-space:nowrap;border:0;border-radius:6px;background:transparent;cursor:pointer;--slicc-agent-tabs-attention-outline:transparent;outline:2px solid var(--slicc-agent-tabs-attention-outline);outline-offset:-2px;animation:slicc-agent-tabs-attention 1.6s ease-in-out infinite;animation-play-state:paused;}
.slicc-agent-tabs__segment:hover{color:var(--ink);}
.slicc-agent-tabs__segment[aria-selected='true']{color:var(--ink);background:var(--canvas);box-shadow:0 1px 3px color-mix(in srgb,var(--ink) 12%,transparent);}
.slicc-agent-tabs__segment[data-attention='true']{--slicc-agent-tabs-attention-outline:var(--ink);animation-play-state:running;}
.slicc-agent-tabs__segment.hide{display:none;}
.slicc-agent-tabs__label{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.slicc-agent-tabs__status-glyph{flex:0 0 14px;width:14px;height:14px;overflow:visible;color:var(--slicc-agent-tabs-hue);}
.slicc-agent-tabs__glyph-base{fill:none;stroke:color-mix(in srgb,currentColor 30%,var(--line));}
.slicc-agent-tabs__glyph-arc{fill:none;stroke:currentColor;stroke-linecap:round;transform:rotate(-90deg);transform-box:fill-box;transform-origin:center;animation:slicc-agent-tabs-arc 10.8s linear infinite;animation-play-state:paused;}
.slicc-agent-tabs__glyph-pin{display:none;fill:currentColor;}
.slicc-agent-tabs__broken-x,.slicc-agent-tabs__initializing-ring{display:none;}
.slicc-agent-tabs [data-state='working'] .slicc-agent-tabs__glyph-arc{animation-play-state:running;}
.slicc-agent-tabs [data-state='working'] .slicc-agent-tabs__glyph-pin{display:inline;}
.slicc-agent-tabs [data-state='broken'] .slicc-agent-tabs__status-glyph{color:var(--red);}
.slicc-agent-tabs [data-state='broken'] .slicc-agent-tabs__glyph-arc,.slicc-agent-tabs [data-state='initializing'] .slicc-agent-tabs__glyph-arc{display:none;}
.slicc-agent-tabs [data-state='broken'] .slicc-agent-tabs__broken-x{display:inline;}
.slicc-agent-tabs [data-state='initializing'] .slicc-agent-tabs__glyph-base{display:none;}
.slicc-agent-tabs [data-state='initializing'] .slicc-agent-tabs__initializing-ring{display:inline;}
.slicc-agent-tabs__broken-x{stroke:currentColor;stroke-linecap:round;}
.slicc-agent-tabs__initializing-ring{fill:none;stroke:currentColor;stroke-dasharray:1.7 1.7;}
.slicc-agent-tabs__overflow{display:none;position:absolute;top:2px;right:2px;width:39px;height:24px;}
.slicc-agent-tabs.has-overflow .slicc-agent-tabs__overflow{display:block;}
.slicc-agent-tabs__overflow-trigger{display:inline-flex;width:39px;height:24px;align-items:center;justify-content:center;padding:0;color:var(--txt-2);border:0;border-radius:6px;background:transparent;cursor:pointer;}
.slicc-agent-tabs__overflow-trigger:hover,.slicc-agent-tabs__overflow-trigger:focus-visible{color:var(--ink);background:var(--ghost);}
.slicc-agent-tabs__overflow-grid{display:grid;width:13px;height:13px;grid-template:repeat(3,3px)/repeat(3,3px);gap:2px;}
.slicc-agent-tabs__overflow-dot{width:3px;height:3px;border-radius:50%;background:var(--txt-3);}
.slicc-agent-tabs__overflow-dot[data-state='broken']{background:var(--red);}
.slicc-agent-tabs__overflow-dot[data-state='working']{background:var(--green);}
.slicc-agent-tabs__overflow-dot[data-state='near-limit']{background:var(--amber);}
.slicc-agent-tabs__overflow-pop{display:none;position:absolute;top:calc(100% + 6px);right:0;min-width:180px;z-index:20;flex-direction:column;gap:4px;}
.slicc-agent-tabs__overflow.open .slicc-agent-tabs__overflow-pop{display:flex;}
.slicc-agent-tabs__overflow-option{display:flex;width:100%;height:30px;align-items:center;gap:8px;padding:0 10px;color:var(--txt-2);font:500 12px/1 var(--ui);text-align:left;border:1px solid var(--line);border-radius:7px;background:var(--canvas);cursor:pointer;}
.slicc-agent-tabs__overflow-option:hover,.slicc-agent-tabs__overflow-option:focus-visible{color:var(--ink);background:var(--ghost);}
.slicc-agent-tabs__overflow-option-dot{width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:var(--slicc-agent-tabs-hue);box-shadow:0 0 0 2px color-mix(in srgb,var(--slicc-agent-tabs-hue) 18%,transparent);}
.slicc-agent-tabs__overflow-option[data-state='working'] .slicc-agent-tabs__overflow-option-dot{background:var(--green);}
.slicc-agent-tabs__overflow-option[data-near-limit='true'] .slicc-agent-tabs__overflow-option-dot{background:var(--amber);}
.slicc-agent-tabs__overflow-option[data-state='broken'] .slicc-agent-tabs__overflow-option-dot{background:var(--red);}
.slicc-agent-tabs__overflow-option-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
@keyframes slicc-agent-tabs-arc{from{transform:rotate(-90deg);}to{transform:rotate(270deg);}}
@keyframes slicc-agent-tabs-attention{0%,100%{outline-color:var(--slicc-agent-tabs-attention-outline);}50%{outline-color:color-mix(in srgb,var(--slicc-agent-tabs-attention-outline) 45%,transparent);}}
@media (prefers-reduced-motion:reduce){.slicc-agent-tabs__glyph-arc{animation:none;transform:rotate(-90deg);}.slicc-agent-tabs__segment{animation:none;}}
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).append(style);
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  ...children: SVGElement[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  element.append(...children);
  return element;
}

function boundedFill(fill: number | undefined): number {
  return typeof fill === 'number' && Number.isFinite(fill) ? Math.max(0, Math.min(100, fill)) : 0;
}

export function arcDash(fill: number): number {
  const sweep = 90 + boundedFill(fill) * 2.7;
  return (sweep / 360) * ARC_CIRCUMFERENCE;
}

function stateFor(scoop: ScoopDescriptor, attention: string | null): AgentState {
  if (scoop.state) return scoop.state;
  if (scoop.eyes === 'dead') return 'broken';
  if (attention === scoop.key) return 'working';
  return 'idle';
}

function typeFor(scoop: ScoopDescriptor): 'cone' | 'scoop' {
  return scoop.type === 'cone' || scoop.key === 'cone' ? 'cone' : 'scoop';
}

function eyesFor(scoop: ScoopDescriptor): 'open' | 'none' | 'dead' {
  return scoop.eyes ?? (typeFor(scoop) === 'cone' ? 'open' : 'none');
}

function hueFor(scoop: ScoopDescriptor): string {
  return DATA_K_HUE[scoop.key] ?? scoop.color ?? 'var(--rose)';
}

function statusGlyph(scoop: ScoopDescriptor): SVGSVGElement {
  const children: SVGElement[] = [
    svgEl('circle', {
      class: `${PREFIX}__glyph-base`,
      cx: 7,
      cy: 7,
      r: ARC_RADIUS,
      'stroke-width': 1.5,
    }),
    svgEl('circle', {
      class: `${PREFIX}__glyph-arc`,
      cx: 7,
      cy: 7,
      r: ARC_RADIUS,
      'stroke-width': 2,
      'stroke-dasharray': `${arcDash(boundedFill(scoop.fill)).toFixed(3)} ${ARC_CIRCUMFERENCE.toFixed(3)}`,
      'stroke-dashoffset': 0,
    }),
    svgEl('circle', { class: `${PREFIX}__glyph-pin`, cx: 7, cy: 7, r: 1.25 }),
    svgEl('line', {
      class: `${PREFIX}__broken-x`,
      x1: 4.8,
      y1: 4.8,
      x2: 9.2,
      y2: 9.2,
      'stroke-width': 1.8,
    }),
    svgEl('line', {
      class: `${PREFIX}__broken-x`,
      x1: 9.2,
      y1: 4.8,
      x2: 4.8,
      y2: 9.2,
      'stroke-width': 1.8,
    }),
    svgEl('circle', {
      class: `${PREFIX}__initializing-ring`,
      cx: 7,
      cy: 7,
      r: ARC_RADIUS,
      'stroke-width': 1.7,
    }),
  ];
  return svgEl(
    'svg',
    {
      class: `${PREFIX}__status-glyph`,
      viewBox: '0 0 14 14',
      width: 14,
      height: 14,
      'aria-hidden': 'true',
    },
    ...children
  );
}

interface OverflowItem {
  id: string;
  label: string;
  color?: string;
  state: AgentState;
  fill: number;
}

function overflowState(item: OverflowItem): 'broken' | 'near-limit' | 'working' | 'idle' {
  if (item.state === 'broken') return 'broken';
  if (item.fill >= 75) return 'near-limit';
  if (item.state === 'working') return 'working';
  return 'idle';
}

function overflowSummary(items: OverflowItem[]): string {
  const severity = { idle: 0, working: 1, 'near-limit': 2, broken: 3 } as const;
  const worst = items.reduce<ReturnType<typeof overflowState>>((current, item) => {
    const state = overflowState(item);
    return severity[state] > severity[current] ? state : current;
  }, 'idle');
  const stateLabel = worst === 'near-limit' ? 'near context limit' : worst;
  return `${items.length} hidden scoop${items.length === 1 ? '' : 's'}; worst state ${stateLabel}`;
}

function overflowGrid(items: OverflowItem[]): HTMLElement {
  const cells = Array.from({ length: 9 }, (_, index) => {
    const item = items[index];
    return h('span', {
      class: `${PREFIX}__overflow-dot`,
      'data-state': item ? overflowState(item) : null,
      'aria-hidden': 'true',
    });
  });
  return h(
    'span',
    {
      class: `${PREFIX}__overflow-grid`,
      role: 'img',
      'aria-label': overflowSummary(items),
      'data-hidden-count': String(items.length),
    },
    ...cells
  );
}

export class SliccAgentTabs extends HTMLElement {
  static readonly observedAttributes = ['active', 'attention'];

  #scoops: ScoopDescriptor[] = [];
  #avatarElement: HTMLElement | null = null;
  #track: HTMLDivElement | null = null;
  #trackFrame: HTMLDivElement | null = null;
  #overflow: HTMLDivElement | null = null;
  #overflowButton: HTMLButtonElement | null = null;
  #overflowPop: HTMLDivElement | null = null;
  #ro: ResizeObserver | null = null;
  #reflowing = false;
  #reflowRaf: number | null = null;
  #initialized = false;
  readonly #onClick = (event: Event): void => this.#handleClick(event);
  readonly #onKeyDown = (event: KeyboardEvent): void => this.#handleKeyDown(event);
  readonly #onDocumentClick = (event: Event): void => {
    if (
      this.#overflow?.classList.contains('open') &&
      event.target instanceof Node &&
      !this.contains(event.target)
    ) {
      this.#setOverflowOpen(false);
    }
  };

  connectedCallback(): void {
    ensureStyle(this.ownerDocument);
    this.classList.add(PREFIX);
    this.setAttribute('part', 'row');
    if (!this.#initialized) this.#initialized = true;
    this.addEventListener('click', this.#onClick);
    this.addEventListener('keydown', this.#onKeyDown);
    this.ownerDocument.addEventListener('click', this.#onDocumentClick);
    this.#render();
    this.#observe();
    requestAnimationFrame(() => this.reflow());
  }

  disconnectedCallback(): void {
    this.#ro?.disconnect();
    this.#ro = null;
    if (this.#reflowRaf !== null) cancelAnimationFrame(this.#reflowRaf);
    this.#reflowRaf = null;
    this.removeEventListener('click', this.#onClick);
    this.removeEventListener('keydown', this.#onKeyDown);
    this.ownerDocument.removeEventListener('click', this.#onDocumentClick);
  }

  attributeChangedCallback(): void {
    if (!this.#initialized || !this.isConnected) return;
    this.#render();
    this.reflow();
  }

  get scoops(): ScoopDescriptor[] {
    return this.#scoops.map((scoop) => ({ ...scoop }));
  }

  set scoops(value: ScoopDescriptor[]) {
    const unique = new Map<string, ScoopDescriptor>();
    if (Array.isArray(value)) {
      for (const scoop of value) {
        if (!unique.has(scoop.key)) unique.set(scoop.key, { ...scoop });
      }
    }
    this.#scoops = [...unique.values()];
    if (this.#initialized && this.isConnected) {
      this.#render();
      this.reflow();
    }
  }

  get attention(): string | null {
    return this.getAttribute('attention');
  }

  set attention(value: string | null) {
    if (value == null) this.removeAttribute('attention');
    else this.setAttribute('attention', value);
  }

  get active(): string | null {
    return this.getAttribute('active');
  }

  set active(value: string | null) {
    if (value == null) this.removeAttribute('active');
    else this.setAttribute('active', value);
  }

  select(key: string): void {
    this.active = key;
    const label = this.#scoops.find((scoop) => scoop.key === key)?.label ?? key;
    this.dispatchEvent(
      new CustomEvent<ScoopSelectDetail>('slicc-scoop-select', {
        detail: { id: key, key, label },
        bubbles: true,
        composed: true,
      })
    );
  }

  reflow(): void {
    if (!this.isConnected || this.#reflowing) return;
    this.#reflowing = true;
    try {
      this.#reflowOnce();
    } finally {
      this.#reflowing = false;
    }
  }

  #reflowOnce(): void {
    const segments = [...this.querySelectorAll<HTMLButtonElement>(`.${PREFIX}__segment`)];
    for (const segment of segments) segment.classList.remove('hide');
    if (segments.length === 0) {
      this.#feedOverflow([]);
      return;
    }
    const available = this.clientWidth;
    if (available <= 0) {
      this.#feedOverflow([]);
      requestAnimationFrame(() => {
        if (this.isConnected && this.clientWidth > 0) this.reflow();
      });
      return;
    }
    const widths = segments.map((segment) => segment.offsetWidth);
    const segmentSpace = Math.max(0, available - AVATAR_WIDTH - HOST_GAP - TRACK_CHROME);
    const total = widths.reduce((sum, width) => sum + width, 0);
    if (total <= segmentSpace + 1) {
      this.#feedOverflow([]);
      return;
    }
    const budget = Math.max(0, segmentSpace - MORE_RESERVE);
    const hidden: HTMLButtonElement[] = [];
    let used = 0;
    segments.forEach((segment, index) => {
      if (index === 0) {
        used += widths[index];
      } else if (hidden.length === 0 && used + widths[index] <= budget) {
        used += widths[index];
      } else {
        segment.classList.add('hide');
        hidden.push(segment);
      }
    });
    this.#feedOverflow(hidden);
  }

  #render(): void {
    const focusedKey = this.#focusedSegmentKey();
    const focused =
      this.#scoops.find((scoop) => scoop.key === this.active) ?? this.#scoops.at(0) ?? null;
    this.#ensureStructure();
    this.#reconcileAvatar(focused);
    this.#reconcileSegments(focused?.key ?? null);
    if (focusedKey != null && !this.#scoops.some((scoop) => scoop.key === focusedKey)) {
      // The focused tab was genuinely removed. Move focus to the selected
      // fallback (normally the first remaining scoop) instead of document.body.
      this.#segmentFor(focused?.key ?? null)?.focus();
    }
  }

  #ensureStructure(): void {
    if (this.#track && this.#trackFrame && this.#overflow && this.contains(this.#trackFrame))
      return;
    this.#track = h('div', {
      class: `${PREFIX}__track`,
      part: 'track',
      role: 'tablist',
      'aria-label': 'Agents',
    }) as HTMLDivElement;
    this.#overflowButton = h(
      'button',
      {
        class: `${PREFIX}__overflow-trigger`,
        part: 'overflow-trigger',
        type: 'button',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
        'aria-label': 'Show hidden scoops',
      },
      overflowGrid([])
    ) as HTMLButtonElement;
    this.#overflowButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#setOverflowOpen(!this.#overflow?.classList.contains('open'));
    });
    this.#overflowPop = h('div', {
      class: `${PREFIX}__overflow-pop`,
      part: 'overflow-pop',
    }) as HTMLDivElement;
    const overflow = h(
      'div',
      { class: `${PREFIX}__overflow`, part: 'overflow' },
      this.#overflowButton,
      this.#overflowPop
    ) as HTMLDivElement;
    this.#overflow = overflow;
    this.#trackFrame = h(
      'div',
      { class: `${PREFIX}__track-frame`, part: 'track-frame' },
      this.#track,
      overflow
    ) as HTMLDivElement;
    this.replaceChildren(this.#trackFrame);
  }

  #avatar(scoop: ScoopDescriptor): HTMLElement {
    const avatar = h(
      'span',
      { class: `${PREFIX}__focus-avatar`, part: 'avatar', role: 'img' },
      h('span', { class: `${PREFIX}__focus-avatar-mark`, 'aria-hidden': 'true' })
    );
    this.#updateAvatar(avatar, scoop);
    return avatar;
  }

  #updateAvatar(avatar: HTMLElement, scoop: ScoopDescriptor): void {
    const state = stateFor(scoop, this.attention);
    const eyeState = eyesFor(scoop);
    const label = scoop.label ?? scoop.key;
    avatar.dataset.type = typeFor(scoop);
    avatar.dataset.eyes = eyeState;
    avatar.dataset.fill = String(Math.round(boundedFill(scoop.fill)));
    avatar.setAttribute('aria-label', `${label} avatar`);
    avatar.style.setProperty('--slicc-agent-tabs-hue', hueFor(scoop));
    const mark = avatar.querySelector<HTMLElement>(`.${PREFIX}__focus-avatar-mark`);
    if (mark) {
      mark.textContent = label.slice(0, 1);
      mark.hidden = eyeState !== 'none';
    }
    let eyes = avatar.querySelector<HTMLElement>('slicc-googly-eyes');
    if (eyeState === 'none') {
      eyes?.remove();
      return;
    }
    if (!eyes) {
      eyes = h('slicc-googly-eyes', { size: 6, tracking: 'on' });
      avatar.append(eyes);
    }
    this.#setAttribute(eyes, 'eyes', eyeState);
    this.#setAttribute(eyes, 'blink', state === 'working');
  }

  #reconcileAvatar(focused: ScoopDescriptor | null): void {
    if (!focused) {
      this.#avatarElement?.remove();
      this.#avatarElement = null;
      return;
    }
    const avatar = this.#avatarElement ?? this.#avatar(focused);
    this.#avatarElement = avatar;
    this.#updateAvatar(avatar, focused);
    if (avatar.parentElement !== this || avatar.nextElementSibling !== this.#trackFrame) {
      this.insertBefore(avatar, this.#trackFrame);
    }
  }

  #segment(scoop: ScoopDescriptor, focused: string | null): HTMLButtonElement {
    const segment = h(
      'button',
      {
        part: 'segment',
        type: 'button',
        role: 'tab',
      },
      statusGlyph(scoop),
      h('span', { class: `${PREFIX}__label` }, scoop.label ?? scoop.key)
    ) as HTMLButtonElement;
    this.#updateSegment(segment, scoop, focused);
    return segment;
  }

  #updateSegment(segment: HTMLButtonElement, scoop: ScoopDescriptor, focused: string | null): void {
    const state = stateFor(scoop, this.attention);
    const fill = boundedFill(scoop.fill);
    const wantsAttention = this.attention === scoop.key;
    segment.className = `${PREFIX}__segment${scoop.ephemeral ? ' ephemeral' : ''}`;
    segment.setAttribute('aria-selected', String(scoop.key === focused));
    segment.tabIndex = scoop.key === focused ? 0 : -1;
    segment.setAttribute(
      'aria-label',
      `${scoop.label ?? scoop.key}: ${state}, ${Math.round(fill)}% context fill${wantsAttention ? ', needs attention' : ''}`
    );
    segment.dataset.k = scoop.key;
    segment.dataset.state = state;
    this.#setAttribute(segment, 'data-attention', wantsAttention ? 'true' : null);
    segment.style.setProperty('--slicc-agent-tabs-hue', hueFor(scoop));
    const label = segment.querySelector<HTMLElement>(`.${PREFIX}__label`);
    if (label) label.textContent = scoop.label ?? scoop.key;
    const arc = segment.querySelector<SVGCircleElement>(`.${PREFIX}__glyph-arc`);
    arc?.setAttribute(
      'stroke-dasharray',
      `${arcDash(fill).toFixed(3)} ${ARC_CIRCUMFERENCE.toFixed(3)}`
    );
  }

  #reconcileSegments(focused: string | null): void {
    if (!this.#track) return;
    const existing = new Map<string, HTMLButtonElement>();
    for (const segment of this.#track.querySelectorAll<HTMLButtonElement>(
      `:scope > .${PREFIX}__segment`
    )) {
      const key = segment.dataset.k ?? '';
      if (existing.has(key)) segment.remove();
      else existing.set(key, segment);
    }
    const desired = this.#scoops.map((scoop) => {
      const segment = existing.get(scoop.key) ?? this.#segment(scoop, focused);
      existing.delete(scoop.key);
      this.#updateSegment(segment, scoop, focused);
      return segment;
    });
    for (const segment of existing.values()) segment.remove();
    desired.forEach((segment, index) => {
      const current = this.#track?.children.item(index) ?? null;
      if (current !== segment) this.#track?.insertBefore(segment, current);
    });
  }

  #setAttribute(element: HTMLElement, name: string, value: string | boolean | null): void {
    if (value === null || value === false) {
      if (element.hasAttribute(name)) element.removeAttribute(name);
    } else if (value === true) {
      if (!element.hasAttribute(name)) element.setAttribute(name, '');
    } else if (element.getAttribute(name) !== value) {
      element.setAttribute(name, value);
    }
  }

  #feedOverflow(hidden: HTMLButtonElement[]): void {
    if (!this.#overflow || !this.#overflowButton || !this.#overflowPop) return;
    const items = hidden.map((segment) => {
      const key = segment.dataset.k ?? '';
      const scoop = this.#scoops.find((item) => item.key === key) ?? { key };
      return {
        id: key,
        label: scoop.label ?? key,
        color: hueFor(scoop),
        state: stateFor(scoop, this.attention),
        fill: boundedFill(scoop.fill),
      };
    });
    this.classList.toggle('has-overflow', items.length > 0);
    this.#overflowButton.setAttribute(
      'aria-label',
      `${items.length} hidden scoop${items.length === 1 ? '' : 's'}. Show hidden scoops`
    );
    this.#overflowButton.replaceChildren(overflowGrid(items));
    this.#overflowPop.replaceChildren(
      ...items.map((item) =>
        h(
          'button',
          {
            class: `${PREFIX}__overflow-option`,
            part: 'overflow-option',
            type: 'button',
            'data-k': item.id,
            'data-state': item.state,
            'data-fill': String(item.fill),
            'data-near-limit': item.fill >= 75 ? 'true' : null,
            style: `--slicc-agent-tabs-hue:${item.color}`,
          },
          h('span', { class: `${PREFIX}__overflow-option-dot`, 'aria-hidden': 'true' }),
          h('span', { class: `${PREFIX}__overflow-option-label` }, item.label)
        )
      )
    );
    if (items.length === 0) this.#setOverflowOpen(false);
  }

  #setOverflowOpen(open: boolean): void {
    this.#overflow?.classList.toggle('open', open);
    this.#overflowButton?.setAttribute('aria-expanded', String(open));
  }

  #handleClick(event: Event): void {
    const target = event.target as HTMLElement | null;
    const option = target?.closest<HTMLButtonElement>(`.${PREFIX}__overflow-option`);
    if (option && this.contains(option) && option.dataset.k) {
      this.#setOverflowOpen(false);
      this.select(option.dataset.k);
      return;
    }
    const segment = target?.closest<HTMLButtonElement>(`.${PREFIX}__segment`);
    if (segment && this.contains(segment) && segment.dataset.k) this.select(segment.dataset.k);
  }

  #handleKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const current = target?.closest<HTMLButtonElement>(`.${PREFIX}__segment`);
    if (!current || !this.contains(current)) return;

    // Manual activation: moving focus must not switch the whole thread view.
    // Enter/Space explicitly activate the focused tab instead.
    if (event.key === 'Enter' || event.key === ' ') {
      if (!current.dataset.k) return;
      event.preventDefault();
      this.select(current.dataset.k);
      return;
    }

    const tabs = [
      ...this.querySelectorAll<HTMLButtonElement>(`.${PREFIX}__segment:not(.hide)`),
    ].filter((segment) => !segment.disabled);
    const index = tabs.indexOf(current);
    if (index < 0 || tabs.length === 0) return;
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    else if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs.at(-1);
    else return;
    event.preventDefault();
    next?.focus();
  }

  #focusedSegmentKey(): string | null {
    const focused = this.ownerDocument.activeElement;
    if (!(focused instanceof Element) || !this.contains(focused)) return null;
    return focused.closest<HTMLButtonElement>(`.${PREFIX}__segment`)?.dataset.k ?? null;
  }

  #segmentFor(key: string | null): HTMLButtonElement | null {
    if (key == null) return null;
    return (
      [...this.querySelectorAll<HTMLButtonElement>(`.${PREFIX}__segment`)].find(
        (segment) => segment.dataset.k === key
      ) ?? null
    );
  }

  #observe(): void {
    if (this.#ro || typeof ResizeObserver === 'undefined') return;
    this.#ro = new ResizeObserver(() => {
      if (this.#reflowRaf !== null) return;
      this.#reflowRaf = requestAnimationFrame(() => {
        this.#reflowRaf = null;
        this.reflow();
      });
    });
    this.#ro.observe(this);
    if (this.parentElement) this.#ro.observe(this.parentElement);
  }
}

define('slicc-agent-tabs', SliccAgentTabs);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-agent-tabs': SliccAgentTabs;
  }
}
