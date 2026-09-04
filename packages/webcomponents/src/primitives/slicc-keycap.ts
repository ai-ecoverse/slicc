import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { hasIcon, iconEl } from '../internal/icons.js';
import { CAP_ICONS } from '../internal/key-caps.js';

/** The three looks. `chiclet` is the default — the quietest of the three. */
const VARIANTS = ['chiclet', 'deck', 'holo'] as const;
export type SliccKeycapVariant = (typeof VARIANTS)[number];
const VARIANT_SET = new Set<string>(VARIANTS);

/** Where the cap floats relative to the box it is pinned inside. */
const PLACEMENTS = ['top-end', 'top-start', 'bottom-end', 'bottom-start', 'end', 'start'] as const;
export type SliccKeycapPlacement = (typeof PLACEMENTS)[number];
const PLACEMENT_SET = new Set<string>(PLACEMENTS);

const PREFIX = 'slicc-keycap';

const STYLE = `
/*
 * The cap floats OVER its target: it pins to the nearest positioned ancestor,
 * which the host makes the target's own box (dock item, tab, toolbar button)
 * or a wrapper around it. Absolute rather than anchor-positioned because a
 * cap has to work inside the extension's shadow trees and inside Cherry's
 * iframe, where an anchor-name on somebody else's element is not ours to set.
 *
 * Never a hit target: the key is the affordance, the cap only names it, and a
 * badge that ate the click on the button it labels would be the worst
 * possible reading of "here is another way to do this".
 */
:host{
  position:absolute;
  z-index:6;
  display:block;
  pointer-events:none;
  font-family:var(--ui);
  /* Stagger seed. The host sets --i per cap so a screenful lands as a sweep
     rather than as one flat pop; unset is simply "first". */
  --i:0;
  --lag:calc(var(--i) * 26ms);
  /* Every variant is a 3D body, so the perspective belongs on the host —
     inside .cap it would be reset by the cap's own transform. */
  perspective:420px;
  perspective-origin:50% 120%;
}
:host([hidden]){display:none;}

/*
 * Desktop only, and enforced HERE rather than trusted to the host: a hint
 * that names a key is a lie on a device with no keyboard, and the touch
 * floats (iOS, the phone-width web app) mount the very same shell markup.
 * A hover-capable fine pointer is the honest test for "there is a keyboard
 * attached", and it is the one media query that stays true when a laptop is
 * docked to a touchscreen.
 */
@media (pointer:coarse),(hover:none){
  :host{display:none;}
}

.cap{
  display:flex;
  align-items:center;
  gap:2px;
  transform-style:preserve-3d;
}

/* One legend. Sized in ems off the host font-size so a host can shrink a
   whole cluster with one declaration. */
.key{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  box-sizing:border-box;
  min-width:1.65em;
  height:1.65em;
  padding:0 .38em;
  border-radius:.42em;
  font:700 1em/1 var(--mono,ui-monospace,monospace);
  letter-spacing:.01em;
  white-space:nowrap;
}
.key svg{display:block;}

:host{font-size:11px;}

/* Placement. The cap overhangs its target's corner by design — a badge fully
   inside the box would cover the icon it is labelling. */
:host([placement='top-end']),:host(:not([placement])){top:-.55em;right:-.75em;}
:host([placement='top-start']){top:-.55em;left:-.75em;}
:host([placement='bottom-end']){bottom:-.55em;right:-.75em;}
:host([placement='bottom-start']){bottom:-.55em;left:-.75em;}
/* The side placements clear the control instead of overhanging it, so they
   are anchored by the EDGE THEY START AT — 'left:100%' plus a gap, not a
   fixed inset from the far edge. An inset would have to know the cap's width
   to leave it outside the box, and it does not: a single legend cleared the
   control, a two-legend pair (the tab strip's arrows) landed back on top of
   the label it was meant to sit beside. */
:host([placement='end']){top:50%;left:100%;margin-left:.5em;transform:translateY(-50%);}
:host([placement='start']){top:50%;right:100%;margin-right:.5em;transform:translateY(-50%);}

/*
 * 'dim' is "the key is bound, the surface it drives is not here" — a read-only
 * unit's send button, a follower's tab strip. Shown, not dropped, for the same
 * reason the HUD shows an unbound press: a cap that vanishes reads as a broken
 * keyboard, and a faded one reads as "not right now".
 */
:host([dim]) .cap{opacity:.42;filter:saturate(.35);}

/* Hover, without motion. 'hot' is set while the pointer is over the cap's
   ANCHOR (see #watchAnchor) — the cap itself has no hit area. The press is in
   the motion block below; this is the part a reduced-motion user still gets,
   because the point of the hover is "this control is the one this key drives"
   and that has to survive the animation being off. */
:host([hot]) .key{border-color:color-mix(in srgb,var(--ctx) 62%,var(--line));}

/* ─── chiclet ─────────────────────────────────────────────────────────────
   The laptop key: one low face, a thin lip, tilted back a few degrees so it
   catches the light from the same direction as the rest of the chrome, and
   floating a hair above its own cast shadow. */
:host([variant='chiclet']) .key,:host(:not([variant])) .key{
  color:var(--ink);
  background:linear-gradient(180deg,color-mix(in srgb,var(--canvas) 92%,#fff) 0%,var(--canvas) 62%,color-mix(in srgb,var(--canvas) 88%,var(--ink)) 100%);
  border:1px solid color-mix(in srgb,var(--ctx) 26%,var(--line));
  box-shadow:
    inset 0 1px 0 color-mix(in srgb,#fff 70%,transparent),
    0 1.5px 0 color-mix(in srgb,var(--ink) 16%,var(--line)),
    0 3px 0 color-mix(in srgb,var(--ink) 8%,var(--line)),
    0 6px 10px -4px color-mix(in srgb,var(--ink) 30%,transparent);
  transform:rotateX(16deg);
}

/* ─── deck ────────────────────────────────────────────────────────────────
   The mechanical key: a tall extrusion built from a stack of hard 1px
   shadows (cheaper and crisper than four rotated wall faces, and it survives
   a subpixel-scaled layout), swivelled on both axes so you read the depth.
   The tinted top face is what makes it look moulded rather than drawn. */
:host([variant='deck']) .key{
  /* NOT --ink: the moulded face is amber in both themes, so a legend that
     followed the theme would go near-white on amber in dark. The legend is
     printed ON the plastic, and printed legends do not invert. */
  color:color-mix(in srgb,var(--waffle,#b07823) 34%,#150d02);
  background:
    radial-gradient(120% 140% at 50% 8%,color-mix(in srgb,#fff 62%,transparent) 0%,transparent 58%),
    linear-gradient(180deg,color-mix(in srgb,var(--ctx) 22%,var(--canvas)) 0%,color-mix(in srgb,var(--ctx) 42%,var(--canvas)) 100%);
  border:1px solid color-mix(in srgb,var(--ctx) 55%,var(--line));
  box-shadow:
    inset 0 1px 1px color-mix(in srgb,#fff 75%,transparent),
    inset 0 -2px 3px color-mix(in srgb,var(--waffle,#b07823) 30%,transparent),
    0 1px 0 var(--kc-edge),0 2px 0 var(--kc-edge),0 3px 0 var(--kc-edge),
    0 4px 0 var(--kc-edge),0 5px 0 var(--kc-edge-deep),
    0 9px 14px -5px color-mix(in srgb,var(--ink) 45%,transparent);
  transform:rotateX(20deg) rotateY(-13deg);
}
:host([variant='deck']){
  --kc-edge:color-mix(in srgb,var(--ctx) 58%,var(--line));
  --kc-edge-deep:color-mix(in srgb,var(--ink) 42%,var(--ctx));
}
/* A chord reads as one moulded row, so the caps lean together instead of each
   swivelling about its own centre. */
:host([variant='deck']) .cap{gap:3px;transform:rotateY(4deg);}

/* ─── holo ────────────────────────────────────────────────────────────────
   The HUD key: no moulding at all — a pane of tinted glass standing off the
   surface, with the app's own rainbow sweeping across it. The one variant
   that reads as software rather than hardware, and the only one that stays
   legible over a photo, a terminal or a diff. */
:host([variant='holo']) .key{
  position:relative;
  overflow:hidden;
  isolation:isolate;
  color:color-mix(in srgb,var(--ctx) 26%,var(--ink));
  background:linear-gradient(158deg,color-mix(in srgb,var(--ctx) 24%,transparent) 0%,color-mix(in srgb,var(--ctx) 7%,transparent) 100%);
  border:1px solid color-mix(in srgb,var(--ctx) 58%,transparent);
  backdrop-filter:blur(9px) saturate(1.7);
  -webkit-backdrop-filter:blur(9px) saturate(1.7);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb,#fff 55%,transparent),
    inset 0 0 12px color-mix(in srgb,var(--ctx) 20%,transparent),
    0 0 0 3px color-mix(in srgb,var(--ctx) 11%,transparent),
    0 10px 22px -10px color-mix(in srgb,var(--ctx) 80%,transparent);
  transform:rotateY(-16deg);
}
/* The tint behind the glass: the app's own rainbow, at a whisper. Its own
   layer rather than a blend mode on the face, because 'overlay' over a dark
   canvas collapses the whole ramp to one muddy hue — the dark theme is where
   this variant has to work hardest. */
:host([variant='holo']) .key::before{
  content:'';
  position:absolute;
  inset:0;
  z-index:-1;
  background:var(--rainbow);
  opacity:.14;
  pointer-events:none;
}
/* The sheen: one narrow raked highlight, wider than the cap and slid across
   it. A band, not a wash — a full-face gradient reads as a loading bar. */
:host([variant='holo']) .key::after{
  content:'';
  position:absolute;
  inset:0;
  z-index:-1;
  background:linear-gradient(102deg,transparent 34%,color-mix(in srgb,#fff 78%,transparent) 50%,transparent 66%);
  background-size:260% 100%;
  background-position:0% 0;
  opacity:.5;
  pointer-events:none;
}

/*
 * Motion. Everything above is the resting frame, so a reduced-motion user
 * gets the same three looks with none of the movement — the caps are a
 * legend, and a legend that only makes sense once it has finished animating
 * is not a legend.
 */
@media (prefers-reduced-motion:no-preference){
  /* Entry, per variant: the chiclet drops onto the surface, the deck is
     pushed in from above and rebounds, the glass swings in edge-on. The
     stagger makes a screenful land as a sweep across the shell. */
  :host([variant='chiclet']) .cap,:host(:not([variant])) .cap{
    animation:${PREFIX}-drop .34s cubic-bezier(.2,1.5,.4,1) both var(--lag);
  }
  :host([variant='deck']) .cap{
    animation:${PREFIX}-punch .42s cubic-bezier(.16,1.44,.36,1) both var(--lag);
  }
  :host([variant='holo']) .cap{
    animation:${PREFIX}-swing .46s cubic-bezier(.2,1.1,.3,1) both var(--lag);
  }

  /* Idle. Only the two weightless variants keep moving; the deck is a moulded
     lump of plastic and floating it would be a lie about what it is. */
  :host([variant='chiclet']) .key,:host(:not([variant])) .key{
    animation:${PREFIX}-bob 3.6s ease-in-out infinite alternate;
    animation-delay:calc(var(--i) * -280ms);
  }
  :host([variant='holo']) .key{
    animation:${PREFIX}-sway 5.2s ease-in-out infinite alternate;
    animation-delay:calc(var(--i) * -420ms);
  }
  /* Held still on the resting frame while nothing sweeps, so a rail of caps
     is not a rail of blinking lights. */
  :host([variant='holo']) .key::after{
    animation:${PREFIX}-sheen 3.4s ease-in-out infinite;
    animation-delay:calc(var(--i) * 180ms);
  }

  /* Hover: one press, per variant, and ONE — not a loop. Hovering is how you
     ask "what does this do?", and the honest answer is the key going down and
     coming back, the same thing your finger is about to do. A cap that
     wobbled for as long as the pointer sat on it would be answering a
     question nobody asked twice.

     These override the idle animation above rather than composing with it, so
     the key stops bobbing for the length of the press and picks it back up
     after — which is also why every press ENDS on the idle resting frame. */
  :host([hot][variant='chiclet']) .key,:host([hot]:not([variant])) .key{
    animation:${PREFIX}-press .42s cubic-bezier(.3,1.3,.5,1) both;
  }
  :host([hot][variant='deck']) .key{
    animation:${PREFIX}-press-deck .38s cubic-bezier(.3,1.2,.5,1) both;
  }
  :host([hot][variant='holo']) .key{
    animation:${PREFIX}-press-holo .5s ease-out both;
  }
  :host([hot][variant='holo']) .key::after{
    animation:${PREFIX}-sheen .5s ease-out both;
  }
}

@keyframes ${PREFIX}-drop{
  from{opacity:0;transform:translate3d(0,-7px,0) scale(.82);}
  to{opacity:1;transform:none;}
}
@keyframes ${PREFIX}-punch{
  0%{opacity:0;transform:translate3d(0,-14px,0) rotateX(-34deg) scale(1.14);}
  62%{opacity:1;transform:translate3d(0,2px,0) rotateX(6deg) scale(.97);}
  100%{opacity:1;transform:rotateY(4deg);}
}
@keyframes ${PREFIX}-swing{
  from{opacity:0;transform:rotateY(-96deg) translate3d(6px,0,0);}
  to{opacity:1;transform:none;}
}
@keyframes ${PREFIX}-bob{
  from{transform:rotateX(16deg) translateY(0);}
  to{transform:rotateX(16deg) translateY(-1.6px);}
}
@keyframes ${PREFIX}-sway{
  from{transform:rotateY(-14deg);}
  to{transform:rotateY(-2deg) translateY(-1.4px);}
}
@keyframes ${PREFIX}-sheen{
  0%,58%,100%{background-position:0% 0;opacity:0;}
  62%{opacity:.62;}
  92%{background-position:100% 0;opacity:0;}
}

/*
 * The chiclet press. Down onto the surface with the lip collapsing under it
 * (the travel alone reads as a slide, not a key — it is the lip going away
 * that sells the key BOTTOMING OUT), then a rebound overshoot and a wobble
 * that damps out over two swings.
 *
 * Every stop carries all four shadows in the same order so the list
 * interpolates; a keyframe that dropped one would snap.
 */
@keyframes ${PREFIX}-press{
  0%{
    transform:rotateX(16deg) translateY(0) rotate(0deg);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb,#fff 70%,transparent),
      0 1.5px 0 color-mix(in srgb,var(--ink) 16%,var(--line)),
      0 3px 0 color-mix(in srgb,var(--ink) 8%,var(--line)),
      0 6px 10px -4px color-mix(in srgb,var(--ink) 30%,transparent);
  }
  26%{
    transform:rotateX(23deg) translateY(3.2px) rotate(-3deg);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb,#fff 40%,transparent),
      0 0 0 color-mix(in srgb,var(--ink) 16%,var(--line)),
      0 0 0 color-mix(in srgb,var(--ink) 8%,var(--line)),
      0 2px 5px -3px color-mix(in srgb,var(--ink) 42%,transparent);
  }
  54%{
    transform:rotateX(11deg) translateY(-2px) rotate(2.2deg);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb,#fff 78%,transparent),
      0 2.5px 0 color-mix(in srgb,var(--ink) 16%,var(--line)),
      0 4.5px 0 color-mix(in srgb,var(--ink) 8%,var(--line)),
      0 9px 14px -4px color-mix(in srgb,var(--ink) 26%,transparent);
  }
  78%{
    transform:rotateX(17deg) translateY(.6px) rotate(-.9deg);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb,#fff 70%,transparent),
      0 1.5px 0 color-mix(in srgb,var(--ink) 16%,var(--line)),
      0 3px 0 color-mix(in srgb,var(--ink) 8%,var(--line)),
      0 6px 10px -4px color-mix(in srgb,var(--ink) 30%,transparent);
  }
  100%{
    transform:rotateX(16deg) translateY(0) rotate(0deg);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb,#fff 70%,transparent),
      0 1.5px 0 color-mix(in srgb,var(--ink) 16%,var(--line)),
      0 3px 0 color-mix(in srgb,var(--ink) 8%,var(--line)),
      0 6px 10px -4px color-mix(in srgb,var(--ink) 30%,transparent);
  }
}

/* The deck has five layers of extrusion to fall into, so its press is the
   travel down that stack and back — no wobble, because a mechanical key on a
   stem does not swing sideways. */
@keyframes ${PREFIX}-press-deck{
  0%,100%{transform:rotateX(20deg) rotateY(-13deg) translateY(0) scale(1);}
  34%{transform:rotateX(27deg) rotateY(-13deg) translateY(4px) scale(.96);}
  70%{transform:rotateX(18deg) rotateY(-13deg) translateY(-1.2px) scale(1.02);}
}

/* Glass has nothing to bottom out on, so it answers with light: the cap turns
   to face you and the sheen wipes across on cue. */
@keyframes ${PREFIX}-press-holo{
  0%{transform:rotateY(-16deg) scale(1);}
  40%{transform:rotateY(-2deg) scale(1.09);}
  100%{transform:rotateY(-16deg) scale(1);}
}
`;

const SHEET = sheet(STYLE);

/** Split `"⌘ ⇧ P"` into its legends; a lone `" "` still means the space bar. */
function legends(cap: string): string[] {
  const trimmed = cap.trim();
  if (trimmed === '') return cap === '' ? [] : [cap];
  return trimmed.split(/\s+/);
}

/**
 * `<slicc-keycap>` — the floating hint keyboard mode puts next to everything
 * it can reach.
 *
 * The HUD (`<slicc-key-hud>`) answers "did that keystroke go anywhere?" after
 * the fact, and the help sheet answers "what is there?" in a list you have to
 * open. Neither answers the question the mode actually leaves you with, which
 * is "what can I press *at this thing I am looking at*". A cap on the surface
 * itself is that answer, and it is why the mode can be discovered without ever
 * reading the sheet.
 *
 * Purely decorative: `aria-hidden`, no hit area. A screen reader gets the
 * button's own accessible name and the help sheet's list; a cap read out per
 * control would turn every rail into a spelling bee.
 *
 * The host pins it by making the target's box the positioned ancestor (or
 * wrapping the target in one) and setting `--i` through `stagger` so a
 * screenful of caps lands as a sweep rather than a flat pop.
 *
 * @attr cap - the legend(s); space-separated for a chord (`"⌘ ⇧ P"`)
 * @attr variant - `chiclet` (default) | `deck` | `holo`
 * @attr placement - which corner it overhangs (default `top-end`)
 * @attr dim - the key is bound but its surface is unavailable here
 * @attr hot - the anchor is hovered; set by the cap itself, and settable by
 *             a host or a story that needs the pressed frame to hold still
 * @attr stagger - position in the sweep; sets the `--i` animation seed
 * @csspart cap - the row of legends
 * @csspart key - one legend
 */
export class SliccKeycap extends HTMLElement {
  static readonly observedAttributes = ['cap', 'variant', 'placement', 'stagger'];

  readonly #root: ShadowRoot;

  /**
   * The box the cap is pinned inside — its anchor, and the thing whose hover
   * the cap answers. Held so the listeners can come off the SAME node they
   * went on: the dock-tree moves surfaces rather than cloning them, so by the
   * time we are disconnected `parentElement` may already be somebody else.
   */
  #anchor: HTMLElement | null = null;

  /**
   * An anchor named by the host, overriding `parentElement`.
   *
   * Set when the cap cannot BE a child of the control it labels — a shadow
   * component whose default slot means something else, or one whose parent
   * clips. There the shell floats the cap in a layer of its own and points it
   * at the real control, so the hover still belongs to the thing the key
   * drives rather than to the ghost box the cap happens to sit in.
   */
  #pinned: HTMLElement | null = null;

  readonly #onEnter = (): void => {
    this.toggleAttribute('hot', true);
  };
  readonly #onLeave = (): void => {
    this.toggleAttribute('hot', false);
  };

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    // Decoration, and the one thing the mode must not do is narrate itself.
    if (!this.hasAttribute('aria-hidden')) this.setAttribute('aria-hidden', 'true');
    this.#render();
    this.#watchAnchor();
  }

  disconnectedCallback(): void {
    this.#unwatchAnchor();
    // A node yanked out from under the pointer never gets its `pointerleave`,
    // so a cap that came back would come back mid-press.
    this.removeAttribute('hot');
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /**
   * Follow the anchor's hover.
   *
   * The cap cannot answer its own `:hover` — it is `pointer-events: none`, and
   * that is not negotiable (a badge that ate the click on the button it labels
   * would be the worst possible reading of the feature). Nor can the sheet ask
   * whether an ancestor is hovered: `:host-context(:hover)` matches when ANY
   * ancestor is, and `body` is hovered whenever the pointer is in the window,
   * so it is true essentially always.
   *
   * So the cap watches the box it is pinned inside, which is the control (or
   * the wrapper around it) by the host contract — meaning the affordance
   * arrives with no wiring at the host at all.
   */
  #watchAnchor(): void {
    const anchor = this.#pinned ?? this.parentElement;
    if (!anchor || anchor === this.#anchor) return;
    this.#unwatchAnchor();
    this.#anchor = anchor;
    // `pointerenter`/`leave` rather than `over`/`out`: they do not bubble, so
    // moving between the control's own children is not a run of key presses.
    anchor.addEventListener('pointerenter', this.#onEnter);
    anchor.addEventListener('pointerleave', this.#onLeave);
  }

  #unwatchAnchor(): void {
    this.#anchor?.removeEventListener('pointerenter', this.#onEnter);
    this.#anchor?.removeEventListener('pointerleave', this.#onLeave);
    this.#anchor = null;
  }

  /** The legend(s), reflected to the `cap` attribute. */
  get cap(): string {
    return this.getAttribute('cap') ?? '';
  }

  set cap(value: string) {
    this.setAttribute('cap', value);
  }

  /** The look, reflected to `variant`. Unknown values fall back to `chiclet`. */
  get variant(): SliccKeycapVariant {
    const value = this.getAttribute('variant');
    return value && VARIANT_SET.has(value) ? (value as SliccKeycapVariant) : 'chiclet';
  }

  set variant(value: SliccKeycapVariant) {
    this.setAttribute('variant', value);
  }

  /** Which corner the cap overhangs, reflected to `placement`. */
  get placement(): SliccKeycapPlacement {
    const value = this.getAttribute('placement');
    return value && PLACEMENT_SET.has(value) ? (value as SliccKeycapPlacement) : 'top-end';
  }

  set placement(value: SliccKeycapPlacement) {
    this.setAttribute('placement', value);
  }

  /** Bound, but not reachable on this screen — drawn faded rather than dropped. */
  get dim(): boolean {
    return this.hasAttribute('dim');
  }

  set dim(value: boolean) {
    this.toggleAttribute('dim', value);
  }

  /**
   * The element whose hover this cap answers. Defaults to `parentElement` —
   * the zero-wiring case, where the cap simply lives inside the control it
   * labels.
   *
   * A host sets it when the cap cannot be a child of that control: a shadow
   * component whose default slot already means something (`<slicc-icon-button>`
   * replaces its glyph), or one inside a container that clips. The shell then
   * floats the cap over a measured ghost of the control and points it here, so
   * the press still belongs to the thing the key actually drives.
   *
   * A property rather than an attribute: it is an element reference, and one
   * that a document-order attribute selector could not name anyway.
   */
  get anchor(): HTMLElement | null {
    return this.#pinned;
  }

  set anchor(value: HTMLElement | null) {
    if (value === this.#pinned) return;
    this.#pinned = value;
    // Live re-point: the shell re-resolves its targets whenever the chrome
    // rebuilds, and the cap has to follow the new node, not the dead one.
    this.#unwatchAnchor();
    this.removeAttribute('hot');
    if (this.isConnected) this.#watchAnchor();
  }

  #render(): void {
    // The seed lives in an inline custom property rather than in the sheet:
    // one shared constructable stylesheet cannot carry a per-instance value.
    const stagger = Number.parseInt(this.getAttribute('stagger') ?? '', 10);
    this.style.setProperty('--i', String(Number.isFinite(stagger) ? stagger : 0));

    const row = h('span', { class: 'cap', part: 'cap' });
    for (const legend of legends(this.cap)) {
      const key = h('kbd', { class: 'key', part: 'key' });
      const icon = CAP_ICONS[legend];
      if (icon && hasIcon(icon)) key.append(iconEl(icon, { size: 12, strokeWidth: 2.4 }));
      else key.textContent = legend;
      row.append(key);
    }
    this.#root.replaceChildren(row);
  }
}

define('slicc-keycap', SliccKeycap);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-keycap': SliccKeycap;
  }
}
