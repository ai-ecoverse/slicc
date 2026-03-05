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

  render(): void {
    if (!this.orchestrator) return;

    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);

    // Scoops first, cone last (cone holds the scoops)
    const allScoops = this.orchestrator.getScoops();
    const scoops = [...allScoops.filter(s => !s.isCone), ...allScoops.filter(s => s.isCone)];
    const selected = scoops.find(s => s.jid === this.selectedJid) ?? scoops.find(s => s.isCone) ?? scoops[0];

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
    const icon = document.createElement('span');
    icon.className = 'scoop-dd__icon';
    if (!scoop) return icon;

    if (scoop.isCone) {
      icon.classList.add('scoop-dd__icon--cone');
      icon.textContent = '\uD83C\uDF66';
    } else {
      icon.textContent = '\uD83D\uDCA9';
      const scoopIndex = allScoops.filter(s => !s.isCone).indexOf(scoop);
      const hue = (scoopIndex * 72) % 360;
      icon.style.filter = `invert(0.85) sepia(1) saturate(4) hue-rotate(${hue}deg) brightness(1.05)`;
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
        margin-left: 12px;
      }

      .scoop-dd__trigger {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border: 1px solid #444;
        border-radius: 6px;
        background: #2a2a3a;
        color: #e0e0f0;
        font-size: 13px;
        cursor: pointer;
        white-space: nowrap;
      }

      .scoop-dd__trigger:hover {
        background: #3a3a5a;
      }

      .scoop-dd__trigger--busy {
        border-color: #eeee90;
      }

      .scoop-dd__trigger--error {
        border-color: #ee9090;
      }

      .scoop-dd__arrow {
        font-size: 10px;
        opacity: 0.6;
      }

      .scoop-dd__menu {
        position: absolute;
        top: 100%;
        left: 0;
        margin-top: 4px;
        min-width: 180px;
        background: #1e1e2e;
        border: 1px solid #444;
        border-radius: 8px;
        padding: 4px 0;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        z-index: 1000;
      }

      .scoop-dd__item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        cursor: pointer;
        font-size: 13px;
        color: #c0c0d0;
        transition: background 0.1s;
      }

      .scoop-dd__item:hover {
        background: #2a2a4a;
      }

      .scoop-dd__item--active {
        background: #2a2a4a;
        color: #e94560;
        font-weight: 600;
      }

      .scoop-dd__item--busy .scoop-dd__label {
        color: #eeee90;
      }

      .scoop-dd__item--error .scoop-dd__label {
        color: #ee9090;
      }

      .scoop-dd__item--add {
        border-top: 1px solid #333;
        margin-top: 4px;
        padding-top: 8px;
        color: #808090;
      }

      .scoop-dd__item--add:hover {
        color: #e94560;
      }

      .scoop-dd__icon {
        font-size: 16px;
        width: 20px;
        text-align: center;
        flex-shrink: 0;
      }

      .scoop-dd__icon--cone {
        clip-path: polygon(0% 45%, 100% 45%, 100% 100%, 0% 100%);
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
        color: #eeee90;
        animation: scoop-pulse 1s infinite;
      }

      .scoop-dd__status--error {
        color: #ee9090;
      }

      @keyframes scoop-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }

      .scoop-dd__delete {
        font-size: 14px;
        color: #808090;
        opacity: 0;
        cursor: pointer;
        transition: opacity 0.1s, color 0.1s;
        flex-shrink: 0;
      }

      .scoop-dd__item:hover .scoop-dd__delete {
        opacity: 1;
      }

      .scoop-dd__delete:hover {
        color: #ee9090;
      }
    `;
    document.head.appendChild(style);
  }
}
