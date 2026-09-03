import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import type { AgentActivity } from './avatar-expression.js';
import type { SliccAgentAvatar } from './slicc-agent-avatar.js';
import './slicc-agent-avatar.js';
import './slicc-scoop-overflow.js';
import type {
  SliccScoopOverflow,
  SliccScoopOverflowItem,
  SliccScoopSelectDetail,
} from './slicc-scoop-overflow.js';

export type AgentState = 'working' | 'broken' | 'initializing' | 'idle';

/**
 * What a `working` agent is busy WITH, mirroring `<slicc-send-button>`'s
 * `phase` attribute so one motion vocabulary covers the whole app: rectangular
 * means the model is thinking, circular means a tool is running. The send
 * button spends it on motion (pulsing square vs spinning ring); at 14px the tab
 * glyph spends it on the centre pin's shape instead. Only meaningful while
 * {@link AgentState} is `working`.
 */
export type AgentPhase = 'thinking' | 'tool';

export interface ScoopDescriptor {
  key: string;
  type?: 'cone' | 'scoop';
  color?: string;
  label?: string;
  eyes?: 'open' | 'none' | 'dead';
  fill?: number;
  ephemeral?: boolean;
  state?: AgentState;
  /**
   * Busy detail for a `working` agent — `tool` while a tool call is in flight,
   * `thinking` (the default) while waiting on or streaming from the model. A
   * turn always opens in `thinking`, so an unset phase reads as thinking rather
   * than as "unknown".
   */
  phase?: AgentPhase;
  /**
   * An `idle` agent whose turn has just ended and whose composer is ready for
   * you. It makes eye contact with the `gaze-target` instead of wandering, and
   * drowses if you keep it waiting.
   *
   * Derived by the leader and, since the expression grammar reached the tray
   * protocol, carried to followers as the `ScoopSummary.activity: 'awaiting'`
   * refinement — which the follower expands back into this field. The wire's
   * own `state`, like {@link AgentState}, stays a four-value union: detail
   * rides the optional field that older followers never read.
   */
  awaiting?: boolean;
}

export interface ScoopSelectDetail extends SliccScoopSelectDetail {
  key: string;
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
const SEGMENT_FLOOR_LABEL = 'sliccy';
const SEGMENT_GLYPH_WIDTH = 14;
const SEGMENT_GAP = 5;
const SEGMENT_INLINE_PADDING = 16;
// Canvas measureText of the lowercase constant under-measures the capitalised rendered label
// and disagrees with layout metrics across font stacks.
const SEGMENT_FLOOR_SLACK = 4;
const SEGMENT_FLOOR_FALLBACK = 65;

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
.slicc-agent-tabs__focus-avatar{display:block;flex:0 0 ${AVATAR_WIDTH}px;width:${AVATAR_WIDTH}px;height:${AVATAR_WIDTH}px;pointer-events:none;}
.slicc-agent-tabs__track-frame{position:relative;flex:0 1 auto;min-width:0;height:var(--ctl-h,30px);overflow:visible;border:1px solid var(--line);border-radius:9px;background:var(--ghost);}
.slicc-agent-tabs__track{display:flex;align-items:center;min-width:0;height:100%;padding:2px;overflow:hidden;}
.slicc-agent-tabs.has-overflow .slicc-agent-tabs__track{padding-right:${MORE_RESERVE + 2}px;}
.slicc-agent-tabs__segment{position:relative;display:inline-flex;flex:0 1 auto;align-items:center;justify-content:center;gap:${SEGMENT_GAP}px;width:max-content;min-width:var(--slicc-agent-tabs-segment-floor,${SEGMENT_FLOOR_FALLBACK}px);max-width:160px;height:24px;padding:0 8px;overflow:hidden;color:var(--txt-2);font:500 11px/1 var(--ui);white-space:nowrap;border:0;border-radius:6px;background:transparent;cursor:pointer;}
.slicc-agent-tabs__segment:hover{color:var(--ink);}
.slicc-agent-tabs__segment[aria-selected='true']{color:var(--ink);background:var(--canvas);box-shadow:0 1px 3px color-mix(in srgb,var(--ink) 12%,transparent);}
.slicc-agent-tabs__segment.hide{display:none;}
.slicc-agent-tabs__label{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.slicc-agent-tabs__status-glyph{flex:0 0 14px;width:14px;height:14px;overflow:visible;color:var(--slicc-agent-tabs-hue);}
.slicc-agent-tabs__glyph-glow{fill:none;stroke:currentColor;opacity:0;filter:drop-shadow(0 0 1px color-mix(in srgb,currentColor 70%,transparent)) drop-shadow(0 0 2.5px color-mix(in srgb,currentColor 35%,transparent));transition:opacity 320ms ease-in-out;}
.slicc-agent-tabs__segment[data-attention='true'] .slicc-agent-tabs__glyph-glow{opacity:.72;}
.slicc-agent-tabs__glyph-base{fill:none;stroke:color-mix(in srgb,currentColor 30%,var(--line));}
.slicc-agent-tabs__glyph-arc{fill:none;stroke:currentColor;stroke-linecap:round;transform:rotate(-90deg);transform-box:fill-box;transform-origin:center;animation:slicc-agent-tabs-arc 10.8s linear infinite;animation-play-state:paused;}
.slicc-agent-tabs__glyph-pin,.slicc-agent-tabs__glyph-pin-square{display:none;fill:currentColor;}
.slicc-agent-tabs__broken-x,.slicc-agent-tabs__initializing-ring{display:none;}
.slicc-agent-tabs [data-state='working'] .slicc-agent-tabs__glyph-arc{animation-play-state:running;}
.slicc-agent-tabs [data-state='working'][data-phase='tool'] .slicc-agent-tabs__glyph-pin{display:inline;}
.slicc-agent-tabs [data-state='working']:not([data-phase='tool']) .slicc-agent-tabs__glyph-pin-square{display:inline;}
.slicc-agent-tabs [data-state='broken'] .slicc-agent-tabs__status-glyph{color:var(--red);}
.slicc-agent-tabs [data-state='broken'] .slicc-agent-tabs__glyph-arc,.slicc-agent-tabs [data-state='initializing'] .slicc-agent-tabs__glyph-arc{display:none;}
.slicc-agent-tabs [data-state='broken'] .slicc-agent-tabs__broken-x{display:inline;}
.slicc-agent-tabs [data-state='initializing'] .slicc-agent-tabs__glyph-base{display:none;}
.slicc-agent-tabs [data-state='initializing'] .slicc-agent-tabs__initializing-ring{display:inline;}
.slicc-agent-tabs__broken-x{stroke:currentColor;stroke-linecap:round;}
.slicc-agent-tabs__initializing-ring{fill:none;stroke:currentColor;stroke-dasharray:1.7 1.7;}
.slicc-agent-tabs slicc-scoop-overflow{display:none;}
.slicc-agent-tabs slicc-scoop-overflow[count]{position:absolute;top:50%;right:2px;display:block;width:39px;height:24px;transform:translateY(-50%);}
.slicc-agent-tabs slicc-scoop-overflow::part(wrap){display:flex;height:24px;}
.slicc-agent-tabs slicc-scoop-overflow::part(more){display:inline-flex;width:39px;height:24px;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;}
.slicc-agent-tabs slicc-scoop-overflow::part(pop){right:0;left:auto;}
@keyframes slicc-agent-tabs-arc{from{transform:rotate(-90deg);}to{transform:rotate(270deg);}}
@media (prefers-reduced-motion:reduce){.slicc-agent-tabs__glyph-arc{animation:none;transform:rotate(-90deg);}.slicc-agent-tabs__glyph-glow{transition:none;}}
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

function segmentFloor(segment: HTMLElement): number {
  const context = segment.ownerDocument.createElement('canvas').getContext('2d');
  const style = segment.ownerDocument.defaultView?.getComputedStyle(segment);
  if (!context || !style) return SEGMENT_FLOOR_FALLBACK;
  context.font = style.font;
  return (
    Math.ceil(
      context.measureText(SEGMENT_FLOOR_LABEL).width +
        SEGMENT_GLYPH_WIDTH +
        SEGMENT_GAP +
        SEGMENT_INLINE_PADDING
    ) + SEGMENT_FLOOR_SLACK
  );
}

export function arcDash(fill: number): number {
  const sweep = 90 + boundedFill(fill) * 2.7;
  return (sweep / 360) * ARC_CIRCUMFERENCE;
}

/**
 * The busy detail for a segment, or `null` when it does not apply. Only a
 * `working` agent has a phase; everything else (idle, broken, initializing)
 * would render a meaningless attribute.
 */
function phaseFor(scoop: ScoopDescriptor, state: AgentState): AgentPhase | null {
  if (state !== 'working') return null;
  return scoop.phase === 'tool' ? 'tool' : 'thinking';
}

/**
 * The avatar's expression channel, derived from the same lifecycle the segment
 * pin uses: a tool call squares the eyes up, model-wait gets the quizzical
 * thinking face, and a finished turn switches idle's lazy wander for eye
 * contact. `broken` and `initializing` keep their own eye treatments (dead /
 * none), so they carry no activity at all.
 */
function activityFor(scoop: ScoopDescriptor, state: AgentState): AgentActivity | null {
  if (state === 'working') return phaseFor(scoop, state) === 'tool' ? 'working' : 'thinking';
  if (state === 'idle') return scoop.awaiting ? 'awaiting' : 'idle';
  return null;
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
  return scoop.eyes ?? 'open';
}

function hueFor(scoop: ScoopDescriptor): string {
  return DATA_K_HUE[scoop.key] ?? scoop.color ?? 'var(--rose)';
}

function statusGlyph(scoop: ScoopDescriptor): SVGSVGElement {
  const children: SVGElement[] = [
    svgEl('circle', {
      class: `${PREFIX}__glyph-glow`,
      cx: 7,
      cy: 7,
      r: ARC_RADIUS,
      'stroke-width': 1.5,
    }),
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
    // Both pins are always built; CSS shows exactly one, chosen by the phase.
    // At this size the shapes only tell themselves apart by their CORNERS, so
    // the square keeps them near-sharp (rx 0.15) and spans 3 — wide enough that
    // its corners sit well outside the circle's 2.5 silhouette. A softer or
    // smaller square just reads as the dot it is replacing. The circle keeps
    // its original radius so the tool phase looks exactly like today's pin.
    // Both are legible from 2x up; at 1x DPI a 3px square and a 3px circle
    // antialias to nearly the same mark, which no geometry here can fix.
    svgEl('circle', { class: `${PREFIX}__glyph-pin`, cx: 7, cy: 7, r: 1.25 }),
    svgEl('rect', {
      class: `${PREFIX}__glyph-pin-square`,
      x: 5.5,
      y: 5.5,
      width: 3,
      height: 3,
      rx: 0.15,
    }),
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

export class SliccAgentTabs extends HTMLElement {
  static readonly observedAttributes = [
    'active',
    'attention',
    'connection',
    'gaze-target',
    'drowse-delay',
  ];

  #scoops: ScoopDescriptor[] = [];
  #avatarElement: SliccAgentAvatar | null = null;
  /** Which agent the reused focus avatar is currently wearing. */
  #avatarKey: string | null = null;
  #track: HTMLDivElement | null = null;
  #trackFrame: HTMLDivElement | null = null;
  #overflow: SliccScoopOverflow | null = null;
  #ro: ResizeObserver | null = null;
  #reflowing = false;
  #reflowRaf: number | null = null;
  #initialized = false;
  #segmentFloor: number | null = null;
  readonly #onClick = (event: Event): void => this.#handleClick(event);
  readonly #onKeyDown = (event: KeyboardEvent): void => this.#handleKeyDown(event);

  connectedCallback(): void {
    ensureStyle(this.ownerDocument);
    this.classList.add(PREFIX);
    this.setAttribute('part', 'row');
    if (!this.#initialized) this.#initialized = true;
    this.addEventListener('click', this.#onClick);
    this.addEventListener('keydown', this.#onKeyDown);
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

  get connection(): 'connected' | 'disconnected' {
    return this.getAttribute('connection') === 'disconnected' ? 'disconnected' : 'connected';
  }

  set connection(value: 'connected' | 'disconnected') {
    this.setAttribute('connection', value);
  }

  /**
   * CSS selector the focused avatar makes eye contact with while `awaiting` —
   * the composer, in the shell. Forwarded verbatim to `<slicc-agent-avatar>`.
   */
  get gazeTarget(): string | null {
    return this.getAttribute('gaze-target');
  }

  set gazeTarget(value: string | null) {
    if (value == null) this.removeAttribute('gaze-target');
    else this.setAttribute('gaze-target', value);
  }

  /**
   * Who owns ←/→ while a segment holds the focus: the strip's own roving walk
   * (`on`, the default) or whoever is listening above it (`off`).
   *
   * The walk `preventDefault()`s the arrows, so a host that binds them
   * globally — the shell's keyboard mode, where they switch units — reads that
   * as "something closer to the key already claimed it" and stands down. A
   * segment is where the focus RESTS after a click, which is exactly where the
   * user is most likely to press an arrow next, so the two would disagree in
   * the commonest state of all: the strip would shuffle its focus ring and the
   * unit would never change.
   *
   * `off` yields those two keys and keeps the rest of the tablist keyboard —
   * Home / End and Enter / Space activation — which nothing above binds.
   */
  get arrowKeys(): 'on' | 'off' {
    return this.getAttribute('arrow-keys') === 'off' ? 'off' : 'on';
  }

  set arrowKeys(value: 'on' | 'off') {
    if (value === 'off') this.setAttribute('arrow-keys', 'off');
    else this.removeAttribute('arrow-keys');
  }

  /**
   * Seconds of `awaiting` before the focused avatar's drowse lid starts to
   * descend. Forwarded verbatim; `null` leaves the avatar's own 90 s default.
   */
  get drowseDelay(): number | null {
    const value = this.getAttribute('drowse-delay');
    if (value === null) return null;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  set drowseDelay(value: number | null) {
    if (value == null) this.removeAttribute('drowse-delay');
    else this.setAttribute('drowse-delay', String(value));
  }

  /** Focused attention on what the user is typing — one call per keystroke. */
  scrutinize(): void {
    this.#avatarElement?.scrutinize();
  }

  /** The reaction to a failed tool call. */
  glower(): void {
    this.#avatarElement?.glower();
  }

  /** "I saw that" — lifts the drowse lid and restarts the waiting clock. */
  wake(): void {
    this.#avatarElement?.wake();
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
    this.classList.remove('has-overflow');
    if (segments.length === 0) {
      this.#feedOverflow([]);
      return;
    }
    if (this.#segmentFloor === null) {
      this.#segmentFloor = segmentFloor(segments[0]);
      this.style.setProperty('--slicc-agent-tabs-segment-floor', `${this.#segmentFloor}px`);
    }
    const available = this.clientWidth;
    if (available <= 0) {
      this.#feedOverflow([]);
      requestAnimationFrame(() => {
        if (this.isConnected && this.clientWidth > 0) this.reflow();
      });
      return;
    }
    const segmentSpace = Math.max(0, available - AVATAR_WIDTH - HOST_GAP - TRACK_CHROME);
    const widthsWithoutReserve = segments.map((segment) => segment.offsetWidth);
    const totalWithoutReserve = widthsWithoutReserve.reduce((sum, width) => sum + width, 0);
    const reserve = segments.length > 1 && totalWithoutReserve > segmentSpace + 1;
    this.classList.toggle('has-overflow', reserve);
    const widths = reserve ? segments.map((segment) => segment.offsetWidth) : widthsWithoutReserve;
    const budget = Math.max(0, segmentSpace - (reserve ? MORE_RESERVE : 0));
    if (!reserve) {
      this.#feedOverflow([]);
      return;
    }
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
    const overflow = this.ownerDocument.createElement('slicc-scoop-overflow') as SliccScoopOverflow;
    overflow.setAttribute('part', 'overflow');
    overflow.addEventListener('slicc-scoop-select', (event: Event) => {
      const id = (event as CustomEvent<SliccScoopSelectDetail>).detail?.id;
      if (typeof id !== 'string') return;
      event.stopPropagation();
      this.select(id);
    });
    this.#overflow = overflow;
    this.#trackFrame = h(
      'div',
      { class: `${PREFIX}__track-frame`, part: 'track-frame' },
      this.#track,
      overflow
    ) as HTMLDivElement;
    this.replaceChildren(this.#trackFrame);
  }

  #avatar(scoop: ScoopDescriptor): SliccAgentAvatar {
    const avatar = h('slicc-agent-avatar', {
      class: `${PREFIX}__focus-avatar`,
      part: 'avatar',
      role: 'img',
    }) as SliccAgentAvatar;
    this.#updateAvatar(avatar, scoop);
    return avatar;
  }

  #updateAvatar(avatar: HTMLElement, scoop: ScoopDescriptor): void {
    const state = stateFor(scoop, this.attention);
    this.#setAttribute(avatar, 'type', typeFor(scoop));
    this.#setAttribute(avatar, 'color', scoop.color ?? null);
    this.#setAttribute(avatar, 'eyes', eyesFor(scoop));
    this.#setAttribute(avatar, 'connection', this.getAttribute('connection'));
    this.#setAttribute(avatar, 'fill', String(Math.round(boundedFill(scoop.fill))));
    this.#setAttribute(avatar, 'blink', state === 'working');
    this.#setAttribute(avatar, 'activity', activityFor(scoop, state));
    this.#setAttribute(avatar, 'gaze-target', this.getAttribute('gaze-target'));
    this.#setAttribute(avatar, 'drowse-delay', this.getAttribute('drowse-delay'));
    this.#setAttribute(avatar, 'aria-label', `${scoop.label ?? scoop.key} focused agent`);
    avatar.style.setProperty('--slicc-agent-tabs-hue', hueFor(scoop));
  }

  #reconcileAvatar(focused: ScoopDescriptor | null): void {
    if (!focused) {
      this.#avatarElement?.remove();
      this.#avatarElement = null;
      this.#avatarKey = null;
      return;
    }
    const avatar = this.#avatarElement ?? this.#avatar(focused);
    this.#avatarElement = avatar;
    // ONE avatar element is reused as focus moves between agents. Without this
    // reset the next agent inherits its predecessor's in-flight glower,
    // scrutiny window, drowse clock and brow pose — a different creature
    // wearing the last one's face. Attributes first, so the reset re-primes
    // the shape to the NEW agent's activity.
    const swapped = this.#avatarKey !== null && this.#avatarKey !== focused.key;
    this.#avatarKey = focused.key;
    this.#updateAvatar(avatar, focused);
    if (swapped) avatar.resetExpression();
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
    const phase = phaseFor(scoop, state);
    const fill = boundedFill(scoop.fill);
    const wantsAttention = this.attention === scoop.key;
    segment.className = `${PREFIX}__segment${scoop.ephemeral ? ' ephemeral' : ''}`;
    segment.setAttribute('aria-selected', String(scoop.key === focused));
    segment.tabIndex = scoop.key === focused ? 0 : -1;
    // The pin's shape is the only carrier of the phase, so spell it out for
    // anyone who cannot see it.
    const busyDetail = phase === 'tool' ? ' (running a tool)' : phase ? ' (thinking)' : '';
    segment.setAttribute(
      'aria-label',
      `${scoop.label ?? scoop.key}: ${state}${busyDetail}, ${Math.round(fill)}% context fill${wantsAttention ? ', spoke most recently' : ''}`
    );
    segment.dataset.k = scoop.key;
    segment.dataset.state = state;
    this.#setAttribute(segment, 'data-phase', phase);
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
    if (!this.#overflow) return;
    const items: Array<SliccScoopOverflowItem & { state?: AgentState; fill?: number }> = hidden.map(
      (segment) => {
        const key = segment.dataset.k ?? '';
        const scoop = this.#scoops.find((item) => item.key === key) ?? { key };
        return {
          id: key,
          label: scoop.label ?? key,
          type: typeFor(scoop),
          color: scoop.color,
          eyes: eyesFor(scoop),
          state: stateFor(scoop, this.attention),
          fill: boundedFill(scoop.fill),
        };
      }
    );
    this.#overflow.items = items;
  }

  #handleClick(event: Event): void {
    const target = event.target as HTMLElement | null;
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

    // Yielded to the host (see {@link arrowKeys}): returning without
    // `preventDefault()` is the whole handover, because the shell's keyboard
    // mode only stands down for a key another handler already claimed.
    const isArrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    if (isArrow && this.arrowKeys === 'off') return;

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
