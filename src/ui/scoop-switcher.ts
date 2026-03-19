/**
 * Scoop Switcher - dropdown for switching between scoops in extension mode.
 * Compact: shows selected scoop + dropdown on click. Fits in the header bar.
 */

import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';
import type { Orchestrator } from '../scoops/orchestrator.js';

export interface ScoopSwitcherCallbacks {
  onScoopSelect: (scoop: RegisteredScoop) => void;
  onCreateScoop: (name: string) => void;
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

  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
    this.render();
  }

  setSelected(jid: string): void {
    this.selectedJid = jid;
    this.render();
  }

  updateStatus(jid: string, status: ScoopTabState['status']): void {
    this.statuses.set(jid, status);
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

        if (!scoop.isCone) {
          const del = document.createElement('span');
          del.className = 'scoop-dd__delete';
          del.textContent = '\u00d7';
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            this.callbacks.onDeleteScoop(scoop.jid);
            this.dropdownOpen = false;
            this.render();
          });
          item.appendChild(del);
        }

        item.addEventListener('click', () => {
          this.selectedJid = scoop.jid;
          this.dropdownOpen = false;
          this.render();
          this.callbacks.onScoopSelect(scoop);
        });

        menu.appendChild(item);
      }

      // Add scoop button
      const addItem = document.createElement('div');
      addItem.className = 'scoop-dd__item scoop-dd__item--add';
      const addIcon = document.createElement('span');
      addIcon.textContent = '+';
      addIcon.style.cssText = 'font-weight: bold; width: 20px; text-align: center;';
      addItem.appendChild(addIcon);
      const addLabel = document.createElement('span');
      addLabel.textContent = 'New scoop';
      addItem.appendChild(addLabel);
      addItem.addEventListener('click', () => {
        this.dropdownOpen = false;
        this.render();
        const name = prompt('Enter scoop name:');
        if (name?.trim()) {
          this.callbacks.onCreateScoop(name.trim());
        }
      });
      menu.appendChild(addItem);

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
        border: 2px solid var(--s2-bg-layer-1, #1a1a2e);
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
    `;
    document.head.appendChild(style);
  }
}
