/**
 * Scoop Switcher - dropdown for switching between scoops in extension mode.
 * Compact: shows selected scoop + dropdown on click. Fits in the header bar.
 */

import type { Orchestrator } from '../scoops/orchestrator.js';
import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';
import { extractLatestUserPrompt, type ScoopScopeLabeler } from './scoop-scope-label.js';

export interface ScoopSwitcherCallbacks {
  onScoopSelect: (scoop: RegisteredScoop) => void;
  onDeleteScoop: (jid: string) => void;
}

export class ScoopSwitcher {
  private container: HTMLElement;
  private orchestrator: Orchestrator | null = null;
  private callbacks: ScoopSwitcherCallbacks;
  private selectedJid: string | null = null;
  private statuses: Map<string, ScoopTabState['status']> = new Map();
  private dropdownOpen = false;
  private lastBadgeCount = 0;
  /** Scope-label cache + LLM driver. When unset, the tooltip still
   *  renders with the name only — same fallback as the standalone
   *  rail's no-API-key path. */
  private labeler: ScoopScopeLabeler | null = null;
  /** Fallback transcript source used to populate the tooltip while
   *  the LLM label is still resolving (or when no API key is
   *  available). Yields the same flat-text shape `labeler` expects. */
  private fetchFallbackTranscript: ((jid: string) => Promise<string>) | null = null;
  /** Per-jid pending fallback line — last user prompt extracted from
   *  the transcript for the no-scope-label branch. Populated lazily on
   *  hover so we don't fan-out transcript fetches before the user
   *  actually opens the dropdown. */
  private fallbackLines = new Map<string, string>();

  constructor(container: HTMLElement, callbacks: ScoopSwitcherCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.addStyles();

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (this.dropdownOpen && !this.container.contains(e.target as Node)) {
        this.dropdownOpen = false;
        this.render();
      }
    });
  }

  /** Wire the scope-label generator + fallback transcript source.
   *  `fetchFallbackTranscript` is the SAME accessor the labeler uses;
   *  the switcher needs a direct hook so it can extract the latest
   *  user prompt for the no-LLM fallback line without re-implementing
   *  the round-trip. Safe to call once after construction. */
  setLabeler(
    labeler: ScoopScopeLabeler,
    fetchFallbackTranscript: (jid: string) => Promise<string>
  ): void {
    this.labeler = labeler;
    this.fetchFallbackTranscript = fetchFallbackTranscript;
  }

  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
    this.render();
  }

  setSelected(jid: string): void {
    this.selectedJid = jid;
    this.render();
  }

  updateStatus(jid: string, status: ScoopTabState['status']): void {
    const prev = this.statuses.get(jid);
    this.statuses.set(jid, status);
    // Pre-warm the scope label whenever a scoop transitions INTO
    // 'processing' — that's the same edge `ChatPanel` produces when
    // the user sends input. Mirrors the standalone rail's pre-warm
    // hook on `Orchestrator.updateScoopStatus`.
    if (status === 'processing' && prev !== 'processing') {
      this.requestLabel(jid);
    }
    this.render();
  }

  /** Re-render the dropdown (e.g., after scoop list changes). */
  refresh(): void {
    this.render();
  }

  render(): void {
    if (!this.orchestrator) return;

    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);

    // Scoops first, cone last (cone holds the scoops)
    const allScoops = this.orchestrator.getScoops();
    const scoops = [...allScoops.filter((s) => !s.isCone), ...allScoops.filter((s) => s.isCone)];
    const selected =
      scoops.find((s) => s.jid === this.selectedJid) ?? scoops.find((s) => s.isCone) ?? scoops[0];

    // Selected scoop button (always visible)
    const trigger = document.createElement('button');
    trigger.className = 'scoop-dd__trigger';

    const triggerIcon = this.buildIcon(selected, scoops);
    trigger.appendChild(triggerIcon);

    const triggerLabel = document.createElement('span');
    triggerLabel.textContent = selected?.isCone ? 'cone' : (selected?.assistantLabel ?? 'select');
    trigger.appendChild(triggerLabel);

    const arrow = document.createElement('span');
    arrow.className = 'scoop-dd__arrow';
    arrow.textContent = this.dropdownOpen ? '\u25B4' : '\u25BE';
    trigger.appendChild(arrow);

    // Status indicator on trigger
    if (selected) {
      const status = this.statuses.get(selected.jid);
      if (status === 'processing') trigger.classList.add('scoop-dd__trigger--busy');
      if (status === 'error') trigger.classList.add('scoop-dd__trigger--error');
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dropdownOpen = !this.dropdownOpen;
      // Refresh labels for every listed scoop when the dropdown
      // opens. `request` dedupes against the cached signature, so a
      // rapid open/close doesn't burn extra LLM calls.
      if (this.dropdownOpen) {
        for (const s of scoops) this.requestLabel(s.jid);
      }
      this.render();
    });

    // Active scoop count badge (excludes cone — only scoops)
    const activeCount = allScoops.filter((s) => {
      if (s.isCone) return false;
      const status = this.statuses.get(s.jid);
      return status === 'processing';
    }).length;

    if (activeCount > 0) {
      trigger.classList.add('scoop-dd__trigger--scoops-active');

      const badge = document.createElement('span');
      badge.className = 'scoop-dd__badge';
      badge.textContent = String(activeCount);

      if (activeCount !== this.lastBadgeCount) {
        badge.classList.add('scoop-dd__badge--pulse');
      }

      trigger.appendChild(badge);
    }
    this.lastBadgeCount = activeCount;

    this.container.appendChild(trigger);

    // Dropdown menu
    if (this.dropdownOpen) {
      const menu = document.createElement('div');
      menu.className = 'scoop-dd__menu';

      for (const scoop of scoops) {
        const item = document.createElement('div');
        item.className = 'scoop-dd__item';
        if (scoop.jid === this.selectedJid) item.classList.add('scoop-dd__item--active');

        const status = this.statuses.get(scoop.jid);
        if (status === 'processing') item.classList.add('scoop-dd__item--busy');
        if (status === 'error') item.classList.add('scoop-dd__item--error');

        const icon = this.buildIcon(scoop, scoops);
        item.appendChild(icon);

        const label = document.createElement('span');
        label.className = 'scoop-dd__label';
        label.textContent = scoop.isCone ? 'cone' : scoop.assistantLabel;
        item.appendChild(label);

        if (status) {
          const badge = document.createElement('span');
          badge.className = `scoop-dd__status scoop-dd__status--${status}`;
          badge.textContent = status === 'processing' ? '\u2022' : '';
          item.appendChild(badge);
        }

        item.addEventListener('click', () => {
          this.selectedJid = scoop.jid;
          this.dropdownOpen = false;
          this.hideTooltip(item);
          this.render();
          this.callbacks.onScoopSelect(scoop);
        });

        this.attachItemTooltip(item, scoop);

        menu.appendChild(item);
      }

      this.container.appendChild(menu);
    }
  }

  private buildIcon(scoop: RegisteredScoop | undefined, allScoops: RegisteredScoop[]): HTMLElement {
    const SCOOP_COLORS = ['#f000a0', '#00f0f0', '#90f000', '#15d675', '#e68619'];
    const icon = document.createElement('span');
    icon.className = 'scoop-dd__icon';
    if (!scoop) return icon;

    if (scoop.isCone) {
      icon.style.background = '#f07000';
    } else {
      const scoopIndex = allScoops.filter((s) => !s.isCone).indexOf(scoop);
      icon.style.background = SCOOP_COLORS[scoopIndex % SCOOP_COLORS.length];
    }
    return icon;
  }

  /** Wire hover-tooltip listeners on a dropdown item. Extracted from
   *  `render` so the dropdown-item assembly stays readable and the
   *  function complexity stays bounded as new affordances land. */
  private attachItemTooltip(item: HTMLElement, scoop: RegisteredScoop): void {
    const displayName = scoop.isCone ? 'cone' : scoop.assistantLabel;
    item.addEventListener('mouseenter', () => {
      this.showTooltip(item, scoop, displayName);
    });
    item.addEventListener('mouseleave', () => {
      this.hideTooltip(item);
    });
  }

  /** Trigger a scope-label refresh for `jid`. The labeler dedupes
   *  against the cached transcript signature, so this is safe to call
   *  on every `processing` transition and every dropdown open. */
  private requestLabel(jid: string): void {
    if (!this.labeler) return;
    this.labeler.request(jid, (resolvedJid) => {
      const tip = this.activeTooltip;
      if (tip && tip.dataset.jid === resolvedJid) {
        this.applyTooltipContent(tip, resolvedJid);
      }
    });
  }

  /** Currently-mounted hover tooltip element, if any. Tracked so the
   *  labeler's async resolution can update the open tooltip in place
   *  without searching the DOM. */
  private activeTooltip: HTMLDivElement | null = null;

  private showTooltip(item: HTMLElement, scoop: RegisteredScoop, displayName: string): void {
    // Clear any stale tooltip (e.g. dropdown was just opened by
    // hovering one item and then moving to another without leaving
    // the menu).
    document.querySelectorAll('.scoop-switcher-tooltip').forEach((t) => {
      t.remove();
    });

    const tip = document.createElement('div');
    tip.className = 'scoop-switcher-tooltip';
    tip.dataset.jid = scoop.jid;
    tip.dataset.name = displayName;
    document.body.appendChild(tip);

    const rect = item.getBoundingClientRect();
    tip.style.top = `${rect.top + rect.height / 2}px`;
    tip.style.left = `${rect.right + 8}px`;

    this.activeTooltip = tip;
    (item as HTMLElement & { __tip?: HTMLDivElement }).__tip = tip;

    // Initial paint with whatever is currently cached. The labeler
    // request below may resolve in the same tick (cache hit) or later;
    // either way `requestLabel`'s onResolved patches the tooltip in
    // place via `activeTooltip`.
    this.applyTooltipContent(tip, scoop.jid);
    this.requestLabel(scoop.jid);
    void this.warmFallbackLine(scoop.jid);
  }

  private hideTooltip(item: HTMLElement): void {
    const owned = (item as HTMLElement & { __tip?: HTMLDivElement }).__tip;
    if (owned) {
      owned.remove();
      (item as HTMLElement & { __tip?: HTMLDivElement }).__tip = undefined;
    }
    if (this.activeTooltip && !document.body.contains(this.activeTooltip)) {
      this.activeTooltip = null;
    } else if (this.activeTooltip === owned) {
      this.activeTooltip = null;
    }
  }

  /** Render the tooltip content. Always starts with the scoop name on
   *  its own line; appends the LLM scope label when available, else
   *  the latest user prompt (truncated). Never shows "null" or an
   *  empty body. */
  private applyTooltipContent(tip: HTMLDivElement, jid: string): void {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    const name = tip.dataset.name ?? '';
    const nameEl = document.createElement('div');
    nameEl.className = 'scoop-switcher-tooltip__name';
    nameEl.textContent = name;
    tip.appendChild(nameEl);

    const scope = this.labeler?.getCached(jid) ?? null;
    const fallback = this.fallbackLines.get(jid) ?? '';
    const line = scope ?? truncate(fallback, 80);
    if (line.length > 0) {
      const scopeEl = document.createElement('div');
      scopeEl.className = 'scoop-switcher-tooltip__scope';
      scopeEl.textContent = line;
      tip.appendChild(scopeEl);
    }
  }

  /** Extract the most recent `user: …` line from the transcript so
   *  the tooltip has something to show before the labeler resolves
   *  (or when no API key is configured). Cached per jid. */
  private async warmFallbackLine(jid: string): Promise<void> {
    if (!this.fetchFallbackTranscript) return;
    let transcript = '';
    try {
      transcript = await this.fetchFallbackTranscript(jid);
    } catch {
      return;
    }
    const latestUser = extractLatestUserPrompt(transcript);
    if (latestUser.length === 0) return;
    const previous = this.fallbackLines.get(jid);
    if (previous === latestUser) return;
    this.fallbackLines.set(jid, latestUser);
    const tip = this.activeTooltip;
    if (tip && tip.dataset.jid === jid) {
      this.applyTooltipContent(tip, jid);
    }
  }

  private addStyles(): void {
    if (document.getElementById('scoop-switcher-styles')) return;

    const style = document.createElement('style');
    style.id = 'scoop-switcher-styles';
    style.textContent = `
      .scoop-switcher {
        position: relative;
        margin-left: var(--s2-spacing-200);
      }

      .scoop-dd__trigger {
        position: relative;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: var(--s2-spacing-50) var(--s2-spacing-100);
        border: 1px solid var(--s2-border-default);
        border-radius: var(--s2-radius-default);
        background: var(--s2-bg-layer-2);
        color: var(--s2-content-default);
        font-size: var(--s2-font-size-75);
        font-family: var(--s2-font-family);
        cursor: pointer;
        white-space: nowrap;
        transition: all var(--s2-transition-default);
      }

      .scoop-dd__trigger:hover {
        background: var(--s2-bg-elevated);
      }

      .scoop-dd__trigger--busy {
        border-color: var(--s2-notice);
      }

      .scoop-dd__trigger--scoops-active {
        border-color: #FF8BCB;
      }

      .scoop-dd__trigger--error {
        border-color: var(--s2-negative);
      }

      .scoop-dd__arrow {
        font-size: 10px;
        opacity: 0.6;
      }

      .scoop-dd__menu {
        position: absolute;
        top: 100%;
        left: 0;
        margin-top: var(--s2-spacing-50);
        min-width: 180px;
        background: var(--s2-bg-layer-2);
        border: 1px solid var(--s2-border-default);
        border-radius: var(--s2-radius-l);
        padding: var(--s2-spacing-50) 0;
        box-shadow: var(--s2-shadow-elevated);
        z-index: 1000;
      }

      .scoop-dd__item {
        display: flex;
        align-items: center;
        gap: var(--s2-spacing-100);
        padding: var(--s2-spacing-100) var(--s2-spacing-200);
        cursor: pointer;
        font-size: var(--s2-font-size-75);
        color: var(--s2-content-default);
        transition: background var(--s2-transition-default);
        border-radius: var(--s2-radius-s);
        margin: 0 var(--s2-spacing-50);
      }

      .scoop-dd__item:hover {
        background: var(--s2-bg-elevated);
      }

      .scoop-dd__item--active {
        background: var(--s2-bg-elevated);
        color: var(--slicc-cone);
        font-weight: 700;
      }

      .scoop-dd__item--busy .scoop-dd__label {
        color: var(--s2-notice);
      }

      .scoop-dd__item--error .scoop-dd__label {
        color: var(--s2-negative);
      }

      .scoop-dd__item--add {
        border-top: 1px solid var(--s2-border-subtle);
        margin-top: var(--s2-spacing-50);
        padding-top: var(--s2-spacing-100);
        color: var(--s2-content-tertiary);
      }

      .scoop-dd__item--add:hover {
        color: var(--slicc-cone);
      }

      .scoop-dd__icon {
        width: 8px; height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .scoop-dd__label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .scoop-dd__status {
        font-size: 18px;
        line-height: 1;
      }

      .scoop-dd__status--processing {
        color: var(--s2-notice);
        animation: scoop-pulse 1s infinite;
      }

      .scoop-dd__status--error {
        color: var(--s2-negative);
      }

      @keyframes scoop-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }

      .scoop-dd__delete {
        font-size: 14px;
        color: var(--s2-content-disabled);
        opacity: 0;
        cursor: pointer;
        transition: opacity var(--s2-transition-default), color var(--s2-transition-default);
        flex-shrink: 0;
      }

      .scoop-dd__item:hover .scoop-dd__delete {
        opacity: 1;
      }

      .scoop-dd__delete:hover {
        color: var(--s2-negative);
      }

      .scoop-dd__badge {
        position: absolute;
        top: -6px;
        right: -8px;
        background: #FF8BCB;
        color: #fff;
        font-size: 9px;
        font-weight: 700;
        min-width: 16px;
        height: 16px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 4px;
        border: 2px solid var(--s2-bg-layer-1);
        pointer-events: none;
        line-height: 1;
      }

      .scoop-dd__badge--pulse {
        animation: scoop-badge-pulse 0.3s ease-out;
      }

      @keyframes scoop-badge-pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.3); }
        100% { transform: scale(1); }
      }

      /* Hover tooltip for dropdown items — same fixed-position
         pattern as the standalone rail's .scoop-fixed-tooltip. */
      .scoop-switcher-tooltip {
        position: fixed;
        transform: translateY(-50%);
        max-width: 240px;
        padding: 6px 10px;
        background: var(--s2-gray-900);
        color: var(--s2-gray-25);
        font-size: 12px;
        font-family: var(--s2-font-family);
        border-radius: var(--s2-radius-default);
        box-shadow: var(--s2-shadow-elevated);
        z-index: 1100;
        pointer-events: none;
        line-height: 1.3;
      }

      .scoop-switcher-tooltip__name {
        font-weight: 600;
      }

      .scoop-switcher-tooltip__scope {
        margin-top: 2px;
        opacity: 0.85;
        font-weight: 400;
        white-space: normal;
        overflow-wrap: anywhere;
      }
    `;
    document.head.appendChild(style);
  }
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}\u2026`;
}
