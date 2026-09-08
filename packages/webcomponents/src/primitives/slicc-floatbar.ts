import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import {
  type BudgetStatus,
  type BudgetUsage,
  budgetLevel,
  budgetTipFragments,
  formatBudgetFigure,
} from './budget-usage.js';
import type { CostOverlayModel, CostOverlayScoop, SliccCostOverlay } from './slicc-cost-overlay.js';
import './slicc-cost-overlay.js';
import type { FollowerHudRow, SliccFollowerHud } from './slicc-follower-hud.js';
import './slicc-follower-hud.js';
import {
  connectionFill,
  connectionGlow,
  connectionPulses,
  defaultFloatbarStatus,
  type FloatbarConnection,
  type FloatbarFloatKind,
  type FloatbarStatus,
  type FloatbarTrayRole,
  floatKindIcon,
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

/* Status beacon — connection color, float-kind icon, tray-role pip. */
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

/* Budget mode: this segment is the pill's HEADLINE, not an aside, so it
   carries ink weight instead of the muted --txt-2 the rest of the pill uses,
   and takes the level color as the reading worsens. An ok level stays ink: a
   green number on every pill all week trains the eye to ignore the segment,
   which is exactly the segment that has to be believed at 96%. */
.spent--budget {
  font-weight: 600;
  color: var(--ink);
}
.spent--budget[data-budget-level='warn'] {
  color: var(--waffle);
}
.spent--budget[data-budget-level='critical'] {
  color: var(--rose);
  background: color-mix(in srgb, var(--rose) 12%, transparent);
  border-radius: 9999px;
  padding: 2px 7px;
  margin: 0 -2px;
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
  .beacon[data-pulse] .beacon__ring { animation: none; }
}
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-floatbar>` — the Runtime Float Pill from the prototype nav
 * (`.floatbar`). An inline-flex rounded pill carrying a status beacon and a
 * runtime label such as `npx` or `extension`. Self-contained shadow DOM;
 * themes via inherited tokens (--canvas, --line, --txt-2, --rose, --ui,
 * --ctl-h). The linked rose tint is fixed across light/dark.
 *
 * @attr label - the runtime label text (defaults to "CLI float")
 * @attr linked - boolean; rose-tints the border to signal a linked runtime
 * @attr connection - tray link health: offline | connecting | live | stalled |
 *   reconnecting | error (colors the beacon ring)
 * @attr float-kind - serving float: npx | sliccstart | extension | standalone |
 *   cherry | electron | hosted (beacon center icon)
 * @attr tray-role - none | leader | follower (corner pip on the beacon)
 * @attr rate - hourly cost, a number or numeric string (e.g. `23.1`); renders a
 *   coin-icon + formatted `$23.10/h` cost segment after a thin divider
 * @attr spent - cumulative cost shown in the cost overlay's total row
 * @attr budget-percent - percent of a rolling provider budget USED (`9.5`).
 *   Its presence switches the cost segment from `$/h` to a gauge-icon `9.5%`
 *   headline — see {@link BudgetUsage} for why percent used and not remaining
 * @attr budget-status - `ok` | `rate-limited`; a refusing provider paints rose
 *   whatever the percent says
 * @attr budget-window - window name used in copy (default `weekly`)
 * @attr budget-resets - reset copy, ALREADY FORMATTED by the host
 *   (`resets Sun 14 Sep`); this component owns no clock
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
    'connection',
    'float-kind',
    'tray-role',
    'rate',
    'spent',
    'budget-percent',
    'budget-status',
    'budget-window',
    'budget-resets',
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

  /**
   * Percent of the provider's rolling budget consumed, or `null` when this
   * provider bills per token. Setting it is what puts the pill in budget mode.
   */
  get budgetPercent(): number | null {
    const raw = this.getAttribute('budget-percent');
    if (raw == null || raw.trim() === '') return null;
    const n = Number.parseFloat(raw.replace(/%$/, ''));
    return Number.isFinite(n) ? n : null;
  }

  set budgetPercent(value: string | number | null) {
    if (value == null) this.removeAttribute('budget-percent');
    else this.setAttribute('budget-percent', String(value));
  }

  /** Provider status for the window. Anything unrecognized reads as `ok`. */
  get budgetStatus(): BudgetStatus {
    return this.getAttribute('budget-status') === 'rate-limited' ? 'rate-limited' : 'ok';
  }

  set budgetStatus(value: BudgetStatus | null) {
    if (value == null || value === 'ok') this.removeAttribute('budget-status');
    else this.setAttribute('budget-status', value);
  }

  /** Window name used in copy (`weekly`), or `null` for the default. */
  get budgetWindow(): string | null {
    return this.getAttribute('budget-window');
  }

  set budgetWindow(value: string | null) {
    if (value == null) this.removeAttribute('budget-window');
    else this.setAttribute('budget-window', value);
  }

  /** Host-formatted reset copy (`resets Sun 14 Sep`). */
  get budgetResets(): string | null {
    return this.getAttribute('budget-resets');
  }

  set budgetResets(value: string | null) {
    if (value == null) this.removeAttribute('budget-resets');
    else this.setAttribute('budget-resets', value);
  }

  /**
   * The whole window in one assignment, and the single answer to "is this
   * pill in budget mode" — `null` whenever no percent has been reported, so
   * a provider without a usage endpoint keeps the `$` headline untouched.
   */
  get budget(): BudgetUsage | null {
    const percent = this.budgetPercent;
    if (percent == null) return null;
    const usage: BudgetUsage = { percent, status: this.budgetStatus };
    const window = this.budgetWindow;
    if (window) usage.window = window;
    const resets = this.budgetResets;
    if (resets) usage.resets = resets;
    return usage;
  }

  set budget(value: BudgetUsage | null) {
    this.budgetPercent = value ? value.percent : null;
    this.budgetStatus = value?.status ?? null;
    this.budgetWindow = value?.window ?? null;
    this.budgetResets = value?.resets ?? null;
    // No overlay push here: each attribute write re-renders, and a rebuild
    // drops any open card — `#showOverlay` reads `this.budget` when it builds
    // the next one.
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
    const parts: string[] = [this.label, statusTipFragment(this.status)];
    const followers = this.#followers.length;
    if (followers > 0) {
      parts.push(`${followers} ${followers === 1 ? 'follower' : 'followers'}`);
    }
    // In budget mode the window replaces the rate as the thing the tip is
    // for. Session dollars stay, demoted to the tail: on a shared allowance
    // they answer "what did I spend", never "can I keep working".
    const budget = this.budget;
    if (budget) {
      parts.push(...budgetTipFragments(budget));
      const spent = formatSpent(this.spent);
      if (spent) parts.push(`${spent} this session`);
    } else {
      parts.push(formatRate(this.rate));
      parts.push('recency-weighted session avg');
    }
    return parts.join(' · ');
  }

  /**
   * The cost segment in budget mode: a gauge and the percent USED.
   *
   * A `rate-limited` window swaps the gauge for an alert octagon, because a
   * provider that has started refusing calls is a different fact from a high
   * number — the percent it reports can lag the refusal, and "96%" and "the
   * next call will fail" should not look alike.
   */
  #budgetSegment(budget: BudgetUsage): HTMLElement {
    const level = budgetLevel(budget);
    const icon = budget.status === 'rate-limited' ? 'octagon-alert' : 'gauge';
    return h(
      'span',
      {
        class: 'spent spent--budget',
        part: 'spent rate budget',
        'data-budget-level': level,
        'data-budget-status': budget.status ?? 'ok',
        'aria-label': budgetTipFragments(budget).join(' · '),
      },
      iconEl(icon, { size: 12 }),
      h('span', { class: 'amount' }, formatBudgetFigure(budget.percent))
    );
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
      'aria-label': statusTipFragment({ connection, floatKind, trayRole }),
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

    nodes.push(this.#beaconEl(this.status));

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
    const budget = this.budget;
    const spentEl = budget
      ? this.#budgetSegment(budget)
      : h(
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
      overlay.budget = this.budget;
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
