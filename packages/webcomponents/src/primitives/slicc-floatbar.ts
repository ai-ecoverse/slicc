import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import type { CostOverlayModel, CostOverlayScoop, SliccCostOverlay } from './slicc-cost-overlay.js';
import './slicc-cost-overlay.js';
import type { FollowerHudRow, SliccFollowerHud } from './slicc-follower-hud.js';
import './slicc-follower-hud.js';
import {
  connectionFill,
  connectionFromLegacyOnline,
  connectionGlow,
  connectionLabel,
  connectionPulses,
  defaultFloatbarStatus,
  type FloatbarConnection,
  type FloatbarFloatKind,
  type FloatbarStatus,
  type FloatbarTrayRole,
  floatKindIcon,
  floatKindLabel,
  statusTipFragment,
  trayRoleIcon,
} from './floatbar-status.js';

const DEFAULT_LABEL = 'CLI float';

/**
 * Format a spend value into a `$2.41` string. Accepts a number or a numeric
 * string; non-numeric / blank input yields `null` (no cost segment rendered).
 */
function parseSpent(raw: string | null): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number.parseFloat(trimmed.replace(/^\$/, ''));
  if (!Number.isFinite(n)) return null;
  return n;
}

function formatSpent(raw: string | null): string | null {
  const value = parseSpent(raw);
  return value == null ? null : `$${value.toFixed(2)}`;
}

function formatRate(raw: string | null): string {
  return `${formatSpent(raw) ?? '$0.00'}/h`;
}

const DETAIL_CUTOFF = 720;

const STYLE = `
:host {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  box-sizing: border-box;
  height: var(--ctl-h, 30px);
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 9999px;
  background: var(--canvas);
  color: var(--txt-2);
  font-family: var(--ui);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}
:host([hidden]) { display: none; }

/* linked → rose-tinted border (mixes --rose into --line) */
:host([linked]) {
  border-color: color-mix(in srgb, var(--rose) 40%, var(--line));
}

/* Status beacon — connection color, float-kind icon, tray-role pip. Replaces
   the legacy plain green status dot. */
.beacon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
}
.beacon__ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--beacon-fill, #94a3b8);
  box-shadow: 0 0 0 2.5px var(--beacon-glow, color-mix(in srgb, #94a3b8 18%, transparent));
}
.beacon__icon {
  position: relative;
  z-index: 1;
  display: inline-flex;
  color: var(--canvas, #fff);
  line-height: 0;
}
.beacon__icon svg {
  display: block;
  width: 9px;
  height: 9px;
}
.beacon__role {
  position: absolute;
  right: -3px;
  bottom: -2px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid var(--canvas, #fff);
  background: var(--ink, #111);
  color: var(--canvas, #fff);
  line-height: 0;
}
.beacon__role svg {
  display: block;
  width: 5px;
  height: 5px;
}
.beacon[data-pulse] .beacon__ring {
  animation: beacon-pulse 1.4s ease-in-out infinite;
}
@keyframes beacon-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.08); opacity: 0.82; }
}

/* Legacy alias — tests and older ::part(dot) hooks still resolve. */
.fdot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 22%, transparent);
}

.label { white-space: nowrap; }
.detail { white-space: nowrap; }

/* thin divider between the label and the cost segment */
.sep {
  width: 1px;
  height: 12px;
  flex: 0 0 auto;
  background: var(--line);
}

/* Followers segment: lucide users icon + count. A real button — click opens
   the sync dialog's Status tab, hover/focus reveals the follower HUD. */
.followers {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  margin: 0;
  padding: 2px 6px;
  border: 0;
  border-radius: 9999px;
  background: none;
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.followers:hover,
.followers:focus-visible {
  background: color-mix(in srgb, var(--ctx) 55%, transparent);
  color: var(--ink);
}
.followers svg {
  display: block;
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
}

/* Hourly rate segment: lucide coin icon + formatted amount */
.spent {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.spent svg {
  display: block;
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
}

/* Hover/focus tip surfacing the collapsed label + rate + connection state.
   Hidden in the wide pill (the full label already shows everything); each
   progressively collapsed form reveals it with a dark tooltip surface.
   Decorative (aria-hidden); the accessible name rides the host title attribute. */
.tip {
  position: absolute;
  top: calc(100% + 7px);
  left: 50%;
  transform: translateX(-50%) translateY(-3px);
  background: var(--ink);
  color: var(--canvas, #fff);
  font-family: var(--ui);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  padding: 3px 8px;
  border-radius: 6px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease, transform 0.12s ease;
  z-index: 30;
  display: none;
}

/* Yield to the tabs in three stages, based on the nav's actual inline size:
   auxiliary tray/follower detail, then spend, then the runtime name. */
@container slicc-nav (max-width: 720px) {
  .detail { display: none; }
  :host(:hover) .tip,
  :host(:focus-within) .tip {
    display: block;
    opacity: 1;
    transform: translateX(-50%);
  }
}

@container slicc-nav (max-width: 560px) {
  .sep--spent, .spent { display: none; }
}

/* The followers segment outranks the runtime name: a leader with followers
   keeps the pill (and the count) instead of collapsing to the square badge. */
@container slicc-nav (max-width: 420px) {
  :host(:not([follower-count])) {
    width: var(--ctl-h, 30px);
    aspect-ratio: 1 / 1;
    padding: 0;
    gap: 0;
    justify-content: center;
  }
  .label { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .tip { transition: none; }
}
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-floatbar>` — the Runtime Float Pill from the prototype nav
 * (`.floatbar`). An inline-flex rounded pill carrying a status dot (`.fdot`)
 * and a runtime label such as `CLI · tray · 1 follower`. Self-contained shadow
 * DOM; themes via inherited tokens (--canvas, --line, --txt-2, --rose, --ui,
 * --ctl-h). The green status dot and the linked rose tint are fixed across
 * light/dark.
 *
 * @attr label - the runtime label text (defaults to "CLI float")
 * @attr linked - boolean; rose-tints the border to signal a linked runtime
 * @attr connection - tray link health: offline | connecting | live | stalled |
 *   reconnecting | error (colors the beacon ring)
 * @attr float-kind - serving float: npx | sliccstart | extension | standalone |
 *   cherry | electron | hosted (beacon center icon)
 * @attr tray-role - none | leader | follower (corner pip on the beacon)
 * @attr online - legacy boolean; when `connection` is unset, maps to live/offline
 * @attr rate - hourly cost, a number or numeric string (e.g. `23.1`); renders a
 *   coin-icon + formatted `$23.10/h` cost segment after a thin divider
 * @attr spent - cumulative cost shown in the cost overlay's total row
 * @attr follower-count - READ-ONLY; reflected from the `followers` property
 * @property followers - {@link FollowerHudRow}[]; renders the followers segment
 *   and feeds `<slicc-follower-hud>` on hover/focus
 * @fires slicc-followers-click - the followers segment was activated (open the
 *   sync dialog on its Status tab)
 * @csspart beacon - the status beacon wrapper (connection + float kind + role)
 * @csspart beacon-ring - the colored health ring
 * @csspart beacon-icon - the float-kind icon
 * @csspart beacon-role - the leader/follower pip (when tray-role ≠ none)
 * @csspart dot - alias for {@link csspart beacon}
 * @csspart label - the runtime label span
 * @csspart sep - the thin dividers before the followers and cost segments
 * @csspart followers - the followers segment button
 * @csspart spent - the cost segment wrapper
 * @csspart rate - alias for the cost segment wrapper
 * @csspart tip - the narrow-view hover/focus tooltip surfacing the collapsed label
 * @slot - default slot overrides the label text
 */
export class SliccFloatbar extends HTMLElement {
  static readonly observedAttributes = [
    'label',
    'linked',
    'online',
    'connection',
    'float-kind',
    'tray-role',
    'rate',
    'spent',
  ];

  readonly #root: ShadowRoot;
  #resizeObserver: ResizeObserver | null = null;
  #overlay: SliccCostOverlay | null = null;
  #costModels: CostOverlayModel[] = [];
  #costScoops: CostOverlayScoop[] = [];
  #hideTimer: ReturnType<typeof setTimeout> | undefined;
  #followers: FollowerHudRow[] = [];
  #followerHud: SliccFollowerHud | null = null;
  #followerHideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
    const nav = this.closest('slicc-nav');
    if (nav && typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => this.#syncTitle());
      this.#resizeObserver.observe(nav);
    }
  }

  disconnectedCallback(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    clearTimeout(this.#hideTimer);
    clearTimeout(this.#followerHideTimer);
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (this.isConnected) this.#render();
  }

  /** Runtime label text. Falls back to "CLI float" when unset. */
  get label(): string {
    return this.getAttribute('label') ?? DEFAULT_LABEL;
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Whether the runtime is linked (rose-tinted border). */
  get linked(): boolean {
    return this.hasAttribute('linked');
  }

  set linked(value: boolean) {
    this.toggleAttribute('linked', !!value);
  }

  /** Whether the status dot is shown (online/green). */
  get online(): boolean {
    return this.hasAttribute('online');
  }

  set online(value: boolean) {
    this.toggleAttribute('online', !!value);
  }

  get connection(): FloatbarConnection {
    const raw = this.getAttribute('connection');
    if (
      raw === 'connecting' ||
      raw === 'live' ||
      raw === 'stalled' ||
      raw === 'reconnecting' ||
      raw === 'error'
    ) {
      return raw;
    }
    if (this.hasAttribute('online')) return connectionFromLegacyOnline(true);
    return 'offline';
  }

  set connection(value: FloatbarConnection | null) {
    if (value == null) this.removeAttribute('connection');
    else this.setAttribute('connection', value);
  }

  get floatKind(): FloatbarFloatKind {
    const raw = this.getAttribute('float-kind');
    if (
      raw === 'npx' ||
      raw === 'sliccstart' ||
      raw === 'extension' ||
      raw === 'standalone' ||
      raw === 'cherry' ||
      raw === 'electron' ||
      raw === 'hosted'
    ) {
      return raw;
    }
    return defaultFloatbarStatus().floatKind;
  }

  set floatKind(value: FloatbarFloatKind | null) {
    if (value == null) this.removeAttribute('float-kind');
    else this.setAttribute('float-kind', value);
  }

  get trayRole(): FloatbarTrayRole {
    const raw = this.getAttribute('tray-role');
    if (raw === 'leader' || raw === 'follower') return raw;
    return 'none';
  }

  set trayRole(value: FloatbarTrayRole | null) {
    if (value == null || value === 'none') this.removeAttribute('tray-role');
    else this.setAttribute('tray-role', value);
  }

  /** Resolved status tuple for hosts/tests. */
  get status(): FloatbarStatus {
    return {
      connection: this.connection,
      floatKind: this.floatKind,
      trayRole: this.trayRole,
    };
  }

  set status(value: FloatbarStatus) {
    this.connection = value.connection;
    this.floatKind = value.floatKind;
    this.trayRole = value.trayRole;
    if (value.connection === 'live') this.online = true;
    else if (value.connection === 'offline') this.online = false;
  }

  /** Raw `spent` attribute value (number/string), or `null` when unset. */
  get spent(): string | null {
    return this.getAttribute('spent');
  }

  set spent(value: string | number | null) {
    if (value == null) this.removeAttribute('spent');
    else this.setAttribute('spent', String(value));
  }

  /** Raw hourly `rate` attribute value, or `null` when unset. */
  get rate(): string | null {
    return this.getAttribute('rate');
  }

  set rate(value: string | number | null) {
    if (value == null) this.removeAttribute('rate');
    else this.setAttribute('rate', String(value));
  }

  get costModels(): CostOverlayModel[] {
    return this.#costModels;
  }

  set costModels(value: CostOverlayModel[]) {
    this.#costModels = value;
    if (this.#overlay) this.#overlay.models = value;
  }

  /**
   * The followers attached to this leader. Setting it reflects the count to
   * the read-only `follower-count` attribute (a CSS + test hook) and renders
   * the followers segment; an empty array removes both.
   */
  get followers(): FollowerHudRow[] {
    return this.#followers;
  }

  set followers(value: FollowerHudRow[]) {
    this.#followers = value;
    if (value.length > 0) this.setAttribute('follower-count', String(value.length));
    else this.removeAttribute('follower-count');
    // `#render()` carries an OPEN hud across the rebuild and refreshes its rows
    // (see `#render`), so a follower connecting or leaving updates the card
    // under the cursor instead of yanking it away mid-read.
    if (this.isConnected) this.#render();
    else if (this.#followerHud) this.#followerHud.rows = value;
  }

  get costScoops(): CostOverlayScoop[] {
    return this.#costScoops;
  }

  set costScoops(value: CostOverlayScoop[]) {
    this.#costScoops = value;
    if (this.#overlay) this.#overlay.scoops = value;
  }

  /**
   * The tooltip text for the narrow square badge — the label, the formatted
   * hourly rate, its recency-weighted session context, and connection state,
   * joined with the same ` · `
   * separator the verbose label uses, so the collapsed badge stays legible.
   */
  #tipText(): string {
    const parts: string[] = [this.label];
    if (
      this.hasAttribute('connection') ||
      this.hasAttribute('float-kind') ||
      this.hasAttribute('tray-role')
    ) {
      parts.push(statusTipFragment(this.status));
    } else {
      parts.push(this.online ? 'online' : 'offline');
    }
    const followers = this.#followers.length;
    if (followers > 0) {
      parts.push(`${followers} ${followers === 1 ? 'follower' : 'followers'}`);
    }
    parts.push(formatRate(this.rate));
    parts.push('recency-weighted session avg');
    return parts.join(' · ');
  }

  /** Explicit status model — beacon replaces the legacy dot. */
  #usesStatusBeacon(): boolean {
    return (
      this.hasAttribute('connection') ||
      this.hasAttribute('float-kind') ||
      this.hasAttribute('tray-role')
    );
  }

  /** Whether the new status beacon renders. */
  #showsBeacon(): boolean {
    return this.#usesStatusBeacon();
  }

  /** Legacy plain green dot when only `online` is set. */
  #showsLegacyDot(): boolean {
    return this.online && !this.#usesStatusBeacon();
  }

  #beaconEl(status: FloatbarStatus): HTMLElement {
    const { connection, floatKind, trayRole } = status;
    const ring = h('span', {
      class: 'beacon__ring',
      part: 'beacon-ring',
      style: `--beacon-fill:${connectionFill(connection)};--beacon-glow:${connectionGlow(connection)}`,
    });
    const icon = h(
      'span',
      { class: 'beacon__icon', part: 'beacon-icon' },
      iconEl(floatKindIcon(floatKind), { size: 9, strokeWidth: 2.25 })
    );
    const attrs: Record<string, string> = {
      class: 'beacon',
      part: 'beacon dot',
      'data-connection': connection,
      'data-float-kind': floatKind,
      'aria-label': `${floatKindLabel(floatKind)}, ${connectionLabel(connection)}`,
    };
    if (trayRole !== 'none') attrs['data-tray-role'] = trayRole;
    if (connectionPulses(connection)) attrs['data-pulse'] = '';
    const nodes: Node[] = [ring, icon];
    const roleIcon = trayRoleIcon(trayRole);
    if (roleIcon) {
      nodes.push(
        h(
          'span',
          { class: 'beacon__role', part: 'beacon-role', 'aria-hidden': 'true' },
          iconEl(roleIcon, { size: 5, strokeWidth: 2.5 })
        )
      );
    }
    return h('span', attrs, ...nodes);
  }

  /** Mirror the full tip onto `title` whenever any detail has been collapsed. */
  #syncTitle(): void {
    const nav = this.closest('slicc-nav');
    const style = nav ? getComputedStyle(nav) : null;
    const inlineSize = nav
      ? nav.clientWidth -
        Number.parseFloat(style?.paddingLeft ?? '0') -
        Number.parseFloat(style?.paddingRight ?? '0')
      : Infinity;
    if (inlineSize <= DETAIL_CUTOFF) this.setAttribute('title', this.#tipText());
    else this.removeAttribute('title');
  }

  #render(): void {
    const nodes: Node[] = [];

    if (this.#showsBeacon()) nodes.push(this.#beaconEl(this.status));
    else if (this.#showsLegacyDot()) nodes.push(h('span', { class: 'fdot', part: 'dot' }));

    const [runtime, ...detail] = this.label.split(' · ');
    const fallback = [h('span', { class: 'runtime' }, runtime)];
    if (detail.length > 0) {
      fallback.push(h('span', { class: 'detail' }, ` · ${detail.join(' · ')}`));
    }
    nodes.push(h('span', { class: 'label', part: 'label' }, h('slot', null, ...fallback)));

    if (this.#followers.length > 0) {
      nodes.push(h('span', { class: 'sep sep--followers', part: 'sep' }));
      nodes.push(this.#followersEl(this.#followers.length));
    }

    nodes.push(h('span', { class: 'sep sep--spent', part: 'sep' }));
    const spentEl = h(
      'span',
      { class: 'spent', part: 'spent rate' },
      iconEl('circle-dollar-sign', { size: 12 }),
      h('span', { class: 'amount' }, formatRate(this.rate))
    );
    spentEl.addEventListener('mouseenter', () => this.#showOverlay());
    spentEl.addEventListener('mouseleave', () => this.#scheduleHide());
    nodes.push(spentEl);

    nodes.push(h('span', { class: 'tip', part: 'tip', 'aria-hidden': 'true' }, this.#tipText()));

    // `replaceChildren` drops every existing child, including an open overlay
    // or hud. The cost overlay is rebuilt on next hover, but the follower hud
    // re-renders on every roster change — the one moment the user is most
    // likely to be hovering it — so an OPEN hud is carried across the rebuild
    // with fresh rows rather than torn down. A closed one is discarded as
    // before; it costs nothing to rebuild on the next hover.
    const openHud =
      this.#followerHud?.hasAttribute('open') && this.#followers.length > 0
        ? this.#followerHud
        : null;
    this.#overlay = null;
    this.#followerHud = openHud;
    this.#root.replaceChildren(...nodes);
    if (openHud) {
      openHud.rows = this.#followers;
      this.#root.appendChild(openHud);
    }
    this.#syncTitle();
  }

  /**
   * The followers segment. A `<button>` (not a span) so the roster is
   * keyboard-reachable: focus reveals the HUD exactly like hover, and
   * Enter/Space emits `slicc-followers-click` for the host to open the sync
   * dialog on its Status tab.
   */
  #followersEl(count: number): HTMLElement {
    const label = `${count} ${count === 1 ? 'follower' : 'followers'}`;
    const el = h(
      'button',
      {
        class: 'followers',
        part: 'followers',
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-label': `${label} connected — open session sharing`,
      },
      iconEl('users', { size: 12 }),
      h('span', { class: 'follower-count' }, String(count))
    );
    el.addEventListener('mouseenter', () => this.#showFollowerHud());
    el.addEventListener('mouseleave', () => this.#scheduleFollowerHide());
    el.addEventListener('focus', () => this.#showFollowerHud());
    el.addEventListener('blur', () => this.#scheduleFollowerHide());
    el.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') this.#hideFollowerHud();
    });
    el.addEventListener('click', () => {
      this.#hideFollowerHud();
      this.dispatchEvent(
        new CustomEvent('slicc-followers-click', { bubbles: true, composed: true })
      );
    });
    return el;
  }

  #showFollowerHud(): void {
    clearTimeout(this.#followerHideTimer);
    if (!this.#followerHud) {
      const hud = document.createElement('slicc-follower-hud') as SliccFollowerHud;
      hud.rows = this.#followers;
      hud.hint = 'Click for sharing options.';
      hud.addEventListener('mouseenter', () => this.#showFollowerHud());
      hud.addEventListener('mouseleave', () => this.#scheduleFollowerHide());
      this.#root.appendChild(hud);
      this.#followerHud = hud;
    }
    this.#followerHud.toggleAttribute('open', true);
  }

  #scheduleFollowerHide(): void {
    this.#followerHideTimer = setTimeout(() => this.#hideFollowerHud(), 150);
  }

  #hideFollowerHud(): void {
    clearTimeout(this.#followerHideTimer);
    this.#followerHud?.removeAttribute('open');
  }

  #showOverlay(): void {
    clearTimeout(this.#hideTimer);
    if (!this.#overlay) {
      const overlay = document.createElement('slicc-cost-overlay') as SliccCostOverlay;
      overlay.models = this.#costModels;
      overlay.scoops = this.#costScoops;
      overlay.total = parseSpent(this.spent);
      overlay.addEventListener('mouseenter', () => this.#showOverlay());
      overlay.addEventListener('mouseleave', () => this.#scheduleHide());
      this.#root.appendChild(overlay);
      this.#overlay = overlay;
    }
    this.#overlay.toggleAttribute('open', true);
  }

  #scheduleHide(): void {
    this.#hideTimer = setTimeout(() => {
      if (this.#overlay) this.#overlay.removeAttribute('open');
    }, 150);
  }
}

define('slicc-floatbar', SliccFloatbar);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-floatbar': SliccFloatbar;
  }
}
