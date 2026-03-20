/**
 * Scoops Panel - UI for managing conversation scoops.
 *
 * Provides:
 * - List of registered scoops
 * - Create/delete scoops
 * - Switch active scoop
 * - View scoop status
 */

import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';
import { Orchestrator } from '../scoops/orchestrator.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('scoops-panel');

export interface ScoopsPanelCallbacks {
  /** Called when user selects a scoop */
  onScoopSelect: (scoop: RegisteredScoop) => void;
  /** Called when user sends a message to a scoop */
  onSendMessage: (scoopJid: string, text: string) => void;
  /** Called when the scoop list changes (for logo updates, etc.) */
  onScoopsChanged?: (scoops: RegisteredScoop[]) => void;
}

export class ScoopsPanel {
  private container: HTMLElement;
  private orchestrator: Orchestrator | null = null;
  private callbacks: ScoopsPanelCallbacks;
  private selectedScoopJid: string | null = null;
  private scoopStatuses: Map<string, ScoopTabState['status']> = new Map();
  private expanded = true;

  constructor(container: HTMLElement, callbacks: ScoopsPanelCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
    // Start expanded
    this.container.classList.add('layout__scoops--expanded');
  }

  /** Toggle the nav rail expanded/collapsed state */
  toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.container.classList.toggle('layout__scoops--expanded', this.expanded);
    // Update hamburger icon
    const hamburger = this.container.querySelector('.scoops-hamburger');
    if (hamburger) {
      hamburger.innerHTML = this.expanded
        ? '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M9.86241 16.4551C9.66612 16.4551 9.46886 16.3779 9.32237 16.2246L3.83507 10.5215C3.5548 10.2315 3.5548 9.77247 3.83507 9.48243L9.33507 3.76563C9.62218 3.4668 10.0978 3.45801 10.3946 3.74512C10.6935 4.03223 10.7032 4.50684 10.4151 4.80469L5.41613 10.002L10.4025 15.1855C10.6906 15.4834 10.6808 15.958 10.382 16.2451C10.2374 16.3857 10.0499 16.4551 9.86241 16.4551Z"/><path d="M15.6124 16.4551C15.4161 16.4551 15.2189 16.3779 15.0724 16.2246L9.58507 10.5215C9.3048 10.2315 9.3048 9.77247 9.58507 9.48243L15.0851 3.76563C15.3722 3.4668 15.8478 3.45801 16.1446 3.74512C16.4435 4.03223 16.4532 4.50684 16.1652 4.80469L11.1661 10.002L16.1525 15.1855C16.4406 15.4834 16.4308 15.958 16.132 16.2451C15.9874 16.3857 15.7999 16.4551 15.6124 16.4551Z"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M9.61805 16.2451C9.31922 15.958 9.30945 15.4834 9.59754 15.1855L14.5839 10.002L9.58485 4.80469C9.29677 4.50684 9.30653 4.03223 9.60536 3.74512C9.90223 3.45801 10.3778 3.4668 10.6649 3.76563L16.1649 9.48243C16.4452 9.77247 16.4452 10.2315 16.1649 10.5215L10.6776 16.2246C10.5311 16.3779 10.3339 16.4551 10.1376 16.4551C9.95008 16.4551 9.76258 16.3857 9.61805 16.2451Z"/><path d="M3.86805 16.2451C3.56922 15.958 3.55945 15.4834 3.84754 15.1855L8.83387 10.002L3.83485 4.80469C3.54677 4.50684 3.55653 4.03223 3.85536 3.74512C4.15223 3.45801 4.62782 3.4668 4.91493 3.76563L10.4149 9.48243C10.6952 9.77247 10.6952 10.2315 10.4149 10.5215L4.92763 16.2246C4.78114 16.3779 4.58388 16.4551 4.38759 16.4551C4.20008 16.4551 4.01258 16.3857 3.86805 16.2451Z"/></svg>';
    }
  }

  /** Set the orchestrator instance */
  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
    this.refreshScoops();
  }

  /** Update scoop status */
  updateScoopStatus(jid: string, status: ScoopTabState['status']): void {
    this.scoopStatuses.set(jid, status);
    this.refreshScoops();
  }

  /** Refresh the scoop list */
  refreshScoops(): void {
    if (!this.orchestrator) return;

    // Cone first (sliccy), then scoops
    const allScoops = this.orchestrator.getScoops();
    const scoops = [...allScoops.filter(s => s.isCone), ...allScoops.filter(s => !s.isCone)];
    const listEl = this.container.querySelector('.scoops-list');
    if (!listEl) return;

    // Clear using safe DOM methods
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

    if (scoops.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'scoops-empty';
      empty.textContent = 'No scoops yet. Create one to start.';
      listEl.appendChild(empty);
      return;
    }

    for (const scoop of scoops) {
      const status = this.scoopStatuses.get(scoop.jid) ?? 'inactive';
      const isSelected = scoop.jid === this.selectedScoopJid;

      const item = document.createElement('div');
      item.className = `scoop-item ${isSelected ? 'selected' : ''} status-${status}`;
      item.dataset.jid = scoop.jid;
      item.setAttribute('aria-label', scoop.assistantLabel);

      // Build DOM safely — UXC icon rail: colored scoop icons
      // Figma card design: icon wrapper (40px, colored bg) + content + status + chevron
      const SCOOP_COLORS = ['#f000a0', '#00f0f0', '#90f000', '#15d675', '#e68619'];
      // Lighter tint versions for icon wrapper backgrounds (Figma: subtle bg)
      const SCOOP_BG_COLORS = ['#fde0f0', '#d0f8f8', '#e8fcd0', '#d7f7e1', '#fef0d8'];

      const ns = 'http://www.w3.org/2000/svg';

      // Icon wrapper — 40px square with colored background (Figma style)
      const iconWrap = document.createElement('div');
      const scoopIndex = scoop.isCone ? -1 : scoops.filter(s => !s.isCone).indexOf(scoop);
      const iconColor = scoop.isCone ? '#f07000' : SCOOP_COLORS[scoopIndex % SCOOP_COLORS.length];
      const iconBg = scoop.isCone ? '#fef0d8' : SCOOP_BG_COLORS[scoopIndex % SCOOP_BG_COLORS.length];
      iconWrap.className = `scoop-icon-wrap${scoop.isCone ? ' scoop-icon-wrap--cone' : ''}`;
      iconWrap.style.background = iconBg;

      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', '20');
      svg.setAttribute('height', '20');
      svg.setAttribute('fill', iconColor);

      if (scoop.isCone) {
        // Cone icon (bottom portion of ice cream)
        svg.setAttribute('viewBox', '100 195 230 235');
        const p1 = document.createElementNS(ns, 'path');
        p1.setAttribute('d', 'M331.2,128.8c1.6-4.8,2.4-11.2,2.4-16.8c0-20.8-12.8-40-31.2-48.8c-8-36-47.2-63.2-92.8-63.2c-48,0-88,29.6-93.6,68.8C102.4,79.2,94.4,95.2,94.4,112c0,4.8,0.8,9.6,1.6,13.6c-7.2,9.6-10.4,20.8-10.4,32C85.6,180,100,200,120,208l85.6,212.8c1.6,3.2,4,4.8,7.2,4.8s6.4-1.6,7.2-4.8L305.6,208c20-8,34.4-27.2,34.4-50.4C340,147.2,336.8,136.8,331.2,128.8z M139.2,216l-1.6-3.2h0.8c1.6,0,2.4,0,4,0L139.2,216z M145.6,232.8l23.2-24.8c4.8,6.4,11.2,11.2,18.4,14.4l12,12l-28.8,30.4l-20.8-22.4L145.6,232.8z M210.4,246.4l28.8,30.4L210.4,308l-28.8-31.2L210.4,246.4z M168.8,289.6l1.6-1.6l28.8,32l-12.8,13.6L168.8,289.6z M212,396.8l-18.4-46.4l16.8-18.4l19.2,21.6L212,396.8z M236.8,336l-15.2-16.8l28.8-31.2l4,4L236.8,336z M250.4,264.8l-28.8-30.4l11.2-12c8-3.2,14.4-8,19.2-14.4l25.6,27.2L250.4,264.8z M284,218.4l-6.4-6.4c2.4,0,4.8,0.8,8,0.8h0.8L284,218.4z M285.6,196c-9.6,0-19.2-4-26.4-11.2c-1.6-1.6-4.8-2.4-7.2-2.4c-2.4,0.8-4.8,2.4-5.6,4.8c-6.4,13.6-20,23.2-35.2,23.2c-14.4,0-28-8.8-34.4-21.6c-0.8-2.4-3.2-4-5.6-4.8c-0.8,0-0.8,0-1.6,0c-1.6,0-4,0.8-5.6,2.4c-7.2,6.4-16,9.6-25.6,9.6c-20.8,0-38.4-16.8-38.4-38.4c0-9.6,3.2-18.4,9.6-24.8c1.6-2.4,2.4-5.6,1.6-8c-1.6-4-2.4-8.8-2.4-12.8c0-12.8,6.4-24.8,17.6-32c2.4-1.6,3.2-4,4-6.4c2.4-32,36.8-57.6,78.4-57.6c39.2,0,72.8,23.2,77.6,54.4c0.8,3.2,2.4,5.6,4.8,6.4c15.2,5.6,24.8,20,24.8,36c0,4.8-0.8,10.4-3.2,15.2c-0.8,2.4-0.8,5.6,0.8,8c4.8,6.4,8,14.4,8,23.2C323.2,179.2,306.4,196,285.6,196z');
        svg.appendChild(p1);
      } else {
        // Scoops icon (top portion of ice cream)
        svg.setAttribute('viewBox', '70 0 290 210');
        const sp1 = document.createElementNS(ns, 'path');
        sp1.setAttribute('d', 'M331.2,128.8c1.6-4.8,2.4-11.2,2.4-16.8c0-20.8-12.8-40-31.2-48.8c-8-36-47.2-63.2-92.8-63.2c-48,0-88,29.6-93.6,68.8C102.4,79.2,94.4,95.2,94.4,112c0,4.8,0.8,9.6,1.6,13.6c-7.2,9.6-10.4,20.8-10.4,32C85.6,180,100,200,120,208l85.6,212.8c1.6,3.2,4,4.8,7.2,4.8s6.4-1.6,7.2-4.8L305.6,208c20-8,34.4-27.2,34.4-50.4C340,147.2,336.8,136.8,331.2,128.8z M285.6,196c-9.6,0-19.2-4-26.4-11.2c-1.6-1.6-4.8-2.4-7.2-2.4c-2.4,0.8-4.8,2.4-5.6,4.8c-6.4,13.6-20,23.2-35.2,23.2c-14.4,0-28-8.8-34.4-21.6c-0.8-2.4-3.2-4-5.6-4.8c-0.8,0-0.8,0-1.6,0c-1.6,0-4,0.8-5.6,2.4c-7.2,6.4-16,9.6-25.6,9.6c-20.8,0-38.4-16.8-38.4-38.4c0-9.6,3.2-18.4,9.6-24.8c1.6-2.4,2.4-5.6,1.6-8c-1.6-4-2.4-8.8-2.4-12.8c0-12.8,6.4-24.8,17.6-32c2.4-1.6,3.2-4,4-6.4c2.4-32,36.8-57.6,78.4-57.6c39.2,0,72.8,23.2,77.6,54.4c0.8,3.2,2.4,5.6,4.8,6.4c15.2,5.6,24.8,20,24.8,36c0,4.8-0.8,10.4-3.2,15.2c-0.8,2.4-0.8,5.6,0.8,8c4.8,6.4,8,14.4,8,23.2C323.2,179.2,306.4,196,285.6,196z');
        svg.appendChild(sp1);
      }

      iconWrap.appendChild(svg);
      item.appendChild(iconWrap);

      // Status dot — overlays top-right corner of icon-wrap
      if (status === 'processing' || status === 'ready' || status === 'error') {
        const dot = document.createElement('span');
        dot.className = `scoop-dot scoop-dot--${status}`;
        iconWrap.appendChild(dot);
      }

      // Content: name + subtitle (Figma style)
      const infoEl = document.createElement('div');
      infoEl.className = 'scoop-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'scoop-name';
      nameEl.textContent = scoop.assistantLabel;
      infoEl.appendChild(nameEl);

      const subtitleEl = document.createElement('div');
      subtitleEl.className = 'scoop-subtitle';
      if (status === 'processing') subtitleEl.textContent = 'Working\u2026';
      else if (status === 'ready') subtitleEl.textContent = 'Ready';
      else if (status === 'error') subtitleEl.textContent = 'Error';
      else subtitleEl.textContent = scoop.isCone ? 'Main agent' : 'Sub-agent';
      infoEl.appendChild(subtitleEl);

      item.appendChild(infoEl);

      // Right actions: status checkmark + chevron/delete (Figma style)
      const actionsEl = document.createElement('div');
      actionsEl.className = 'scoop-actions';

      // Status indicators (no checkmark for ready — keep it clean)
      if (status === 'processing') {
        const spinDot = document.createElement('span');
        spinDot.className = 'scoop-spin-dot';
        actionsEl.appendChild(spinDot);
      } else if (status === 'error') {
        const errDot = document.createElement('span');
        errDot.className = 'scoop-err-dot';
        actionsEl.appendChild(errDot);
      }

      // Chevron / delete button
      if (!scoop.isCone) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'scoop-delete';
        deleteBtn.dataset.tooltip = 'Delete scoop';
        deleteBtn.setAttribute('aria-label', 'Delete scoop');
        deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M6 6L14 14M14 6L6 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        actionsEl.appendChild(deleteBtn);
      }

      item.appendChild(actionsEl);

      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.scoop-delete')) {
          this.deleteScoop(scoop.jid);
        } else {
          this.selectScoop(scoop);
        }
      });

      // Collapsed-mode tooltip (fixed position, escapes scroll container)
      const label = scoop.assistantLabel;
      item.addEventListener('mouseenter', () => {
        if (this.expanded) return;
        const tip = document.createElement('div');
        tip.className = 'scoop-fixed-tooltip';
        tip.textContent = label;
        document.body.appendChild(tip);
        const rect = item.getBoundingClientRect();
        tip.style.top = `${rect.top + rect.height / 2}px`;
        tip.style.left = `${rect.right + 8}px`;
        (item as any).__tip = tip;
      });
      item.addEventListener('mouseleave', () => {
        const tip = (item as any).__tip;
        if (tip) { tip.remove(); (item as any).__tip = null; }
      });

      listEl.appendChild(item);
    }

    // Notify listeners of scoop list change
    this.callbacks.onScoopsChanged?.(allScoops);
  }

  /** Select a scoop */
  private selectScoop(scoop: RegisteredScoop): void {
    this.selectedScoopJid = scoop.jid;
    this.refreshScoops();
    this.callbacks.onScoopSelect(scoop);

    // Update URL state
    const url = new URL(window.location.href);
    if (scoop.isCone) {
      url.searchParams.delete('scoop');
    } else {
      url.searchParams.set('scoop', scoop.folder);
    }
    history.replaceState(null, '', url.toString());
  }

  /** Select scoop by folder name (for URL restoration) */
  selectScoopByFolder(folder: string): void {
    if (!this.orchestrator) return;
    const scoops = this.orchestrator.getScoops();
    const scoop = scoops.find(s => s.folder === folder);
    if (scoop) {
      this.selectScoop(scoop);
    }
  }

  /** Get selected scoop JID */
  getSelectedScoopJid(): string | null {
    return this.selectedScoopJid;
  }

  /** Delete a scoop */
  async deleteScoop(jid: string): Promise<void> {
    if (!this.orchestrator) return;

    const scoop = this.orchestrator.getScoop(jid);
    if (!scoop) return;

    if (scoop.isCone) {
      alert('Cannot delete the cone');
      return;
    }

    if (!confirm(`Delete scoop "${scoop.name}"? This cannot be undone.`)) {
      return;
    }

    try {
      await this.orchestrator.unregisterScoop(jid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(msg);
      return;
    }

    if (this.selectedScoopJid === jid) {
      this.selectedScoopJid = null;
    }

    this.refreshScoops();
    log.info('Scoop deleted', { jid, name: scoop.name });
  }

  /** Show create scoop dialog */
  private showCreateDialog(): void {
    const name = prompt('Enter scoop name:');
    if (!name?.trim()) return;

    this.createScoop(name.trim());
  }

  /** Create a new scoop */
  async createScoop(name: string, isCone = false): Promise<RegisteredScoop> {
    if (!this.orchestrator) {
      throw new Error('Orchestrator not set');
    }

    const folder = isCone ? 'cone' : this.sanitizeFolderName(name) + '-scoop';
    const jid = isCone ? `cone_${Date.now()}` : `scoop_${folder}_${Date.now()}`;

    const scoop: RegisteredScoop = {
      jid,
      name,
      folder,
      trigger: isCone ? undefined : `@${folder}`,
      requiresTrigger: !isCone,
      isCone,
      type: isCone ? 'cone' : 'scoop',
      assistantLabel: isCone ? 'sliccy' : folder,
      addedAt: new Date().toISOString(),
    };

    await this.orchestrator.registerScoop(scoop);
    this.refreshScoops();

    log.info('Scoop created', { jid, name, isCone });
    return scoop;
  }

  /** Sanitize a name into a valid folder name */
  private sanitizeFolderName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'scoop';
  }

  /** Render the panel as an icon-only nav rail (UXC design). */
  private render(): void {
    // Build DOM safely
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);

    const panel = document.createElement('div');
    panel.className = 'scoops-panel';

    // Hamburger toggle at top
    const hamburger = document.createElement('button');
    hamburger.className = 'scoops-hamburger';
    hamburger.dataset.tooltip = 'Toggle navigation';
    hamburger.setAttribute('aria-label', 'Toggle navigation');
    hamburger.innerHTML = '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M9.86241 16.4551C9.66612 16.4551 9.46886 16.3779 9.32237 16.2246L3.83507 10.5215C3.5548 10.2315 3.5548 9.77247 3.83507 9.48243L9.33507 3.76563C9.62218 3.4668 10.0978 3.45801 10.3946 3.74512C10.6935 4.03223 10.7032 4.50684 10.4151 4.80469L5.41613 10.002L10.4025 15.1855C10.6906 15.4834 10.6808 15.958 10.382 16.2451C10.2374 16.3857 10.0499 16.4551 9.86241 16.4551Z"/><path d="M15.6124 16.4551C15.4161 16.4551 15.2189 16.3779 15.0724 16.2246L9.58507 10.5215C9.3048 10.2315 9.3048 9.77247 9.58507 9.48243L15.0851 3.76563C15.3722 3.4668 15.8478 3.45801 16.1446 3.74512C16.4435 4.03223 16.4532 4.50684 16.1652 4.80469L11.1661 10.002L16.1525 15.1855C16.4406 15.4834 16.4308 15.958 16.132 16.2451C15.9874 16.3857 15.7999 16.4551 15.6124 16.4551Z"/></svg>';
    hamburger.addEventListener('click', () => this.toggleExpanded());
    panel.appendChild(hamburger);

    const list = document.createElement('div');
    list.className = 'scoops-list';
    panel.appendChild(list);

    // Add button at bottom
    const addBtn = document.createElement('button');
    addBtn.className = 'scoops-add';
    addBtn.dataset.tooltip = 'Create new scoop';
    addBtn.setAttribute('aria-label', 'Create new scoop');
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => this.showCreateDialog());
    panel.appendChild(addBtn);

    this.container.appendChild(panel);

    // Add styles — UXC icon rail mode
    const style = document.createElement('style');
    style.textContent = `
      .scoops-panel {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #f8f8f8;
        color: #292929;
        align-items: flex-start;
        padding: 12px 4px 12px 8px;
        gap: 8px;
        overflow: visible;
      }

      /* Hamburger toggle */
      .scoops-hamburger {
        width: 32px; height: 32px;
        margin-left: 5px;
        border: none; background: transparent;
        color: #505050;
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        align-items: center; justify-content: center;
        flex-shrink: 0;
        transition: background 130ms ease, color 130ms ease;
      }
      .scoops-hamburger:hover {
        background: #e9e9e9;
        color: #292929;
      }

      .scoops-list {
        flex: 1;
        overflow-y: auto;
        scrollbar-width: none;
        -ms-overflow-style: none;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        width: 100%;
        padding: 0;
      }
      .scoops-list::-webkit-scrollbar {
        display: none;
      }

      .scoops-empty {
        padding: var(--s2-spacing-100);
        text-align: center;
        color: var(--s2-content-disabled);
        font-size: 10px;
      }

      .scoop-item {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px; height: 52px;
        margin-left: 5px;
        border-radius: 8px;
        cursor: pointer;
        transition: background var(--s2-transition-default), width 200ms ease;
        position: relative;
        flex-shrink: 0;
        background: transparent;
        overflow: visible;
      }

      .scoop-item:hover {
        background: transparent;
      }

      .scoop-item.selected {
        background: #292929;
      }

      /* Icon wrapper — same size in both modes */
      .scoop-icon-wrap {
        width: 32px; height: 32px;
        border-radius: 6px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
      }
      .scoop-icon-wrap svg {
        width: 18px; height: 18px;
      }

      /* Hide info/actions in rail mode — shown via tooltip */
      .scoop-info { display: none; }
      .scoop-actions { display: none; }

      /* Expanded state — Figma card design */
      .layout__scoops--expanded .scoops-panel {
        align-items: stretch;
        padding: 12px 8px;
        gap: 2px;
      }
      .layout__scoops--expanded .scoop-item {
        width: 100%;
        height: auto;
        justify-content: flex-start;
        padding: 10px 5px;
        margin-left: 0;
        gap: 8px;
        border: none;
        border-radius: 8px;
        background: transparent;
      }
      .layout__scoops--expanded .scoop-item:hover {
        background: #fafafa;
      }
      .layout__scoops--expanded .scoop-item.selected {
        background: #f0f7ff;
      }


      .layout__scoops--expanded .scoop-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
        min-width: 0;
        justify-content: center;
      }
      .layout__scoops--expanded .scoop-name {
        font-size: 13px;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: #292929;
        line-height: 16px;
      }
      .layout__scoops--expanded .scoop-subtitle {
        font-size: 11px;
        font-weight: 400;
        color: #505050;
        line-height: 1.4;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .layout__scoops--expanded .scoop-item.selected .scoop-name {
        color: #292929;
      }

      /* Right actions in expanded mode */
      .layout__scoops--expanded .scoop-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .scoop-spin-dot {
        width: 10px; height: 10px;
        border-radius: 50%;
        background: #e68619;
        animation: spin-pulse 1.2s ease-in-out infinite;
      }
      @keyframes spin-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      .scoop-err-dot {
        width: 10px; height: 10px;
        border-radius: 50%;
        background: var(--s2-negative, #d73220);
      }
      .layout__scoops--expanded .scoop-delete,
      .layout__scoops--expanded .scoop-chevron {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px; height: 28px;
        border: none;
        background: transparent;
        color: #8a8a8a;
        cursor: pointer;
        border-radius: 4px;
        flex-shrink: 0;
        padding: 0;
        transition: background 130ms ease, color 130ms ease;
      }
      .layout__scoops--expanded .scoop-delete:hover {
        background: rgba(0,0,0,0.06);
        color: var(--s2-negative, #d73220);
      }
      .layout__scoops--expanded .scoop-chevron {
        cursor: default;
      }
      .layout__scoops--expanded .scoop-chevron:hover {
        background: rgba(0,0,0,0.06);
        color: #505050;
      }

      .layout__scoops--expanded .scoops-hamburger {
        align-self: flex-end;
        margin-left: 0;
      }
      .layout__scoops--expanded .scoops-add {
        width: 100%;
        margin-left: 0;
        justify-content: center;
      }

      /* Status dot — overlays top-right corner of icon-wrap */
      .scoop-dot {
        position: absolute; top: 0; right: 0;
        width: 9px; height: 9px;
        border-radius: 50%;
        border: 1.5px solid #fff;
        z-index: 1;
        pointer-events: none;
        transform: translate(30%, -30%);
      }
      .scoop-dot--processing { background: #e68619; }
      .scoop-dot--ready { background: var(--s2-positive); }
      .scoop-dot--error { background: var(--s2-negative); }

      /* Fixed tooltip for collapsed mode */
      .scoop-fixed-tooltip {
        position: fixed;
        transform: translateY(-50%);
        padding: 4px 10px;
        background: var(--s2-gray-900);
        color: var(--s2-gray-25);
        font-size: 12px;
        font-weight: 500;
        font-family: var(--s2-font-family);
        white-space: nowrap;
        border-radius: var(--s2-radius-s);
        pointer-events: none;
        z-index: 10000;
        line-height: 1.3;
      }

      .scoops-add {
        width: 32px;
        height: 32px;
        margin-left: 5px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: var(--s2-content-tertiary);
        font-size: 18px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        margin-bottom: var(--s2-spacing-200);
        transition: background var(--s2-transition-default), color var(--s2-transition-default);
      }

      .scoops-add:hover {
        background: #e9e9e9;
        color: #292929;
      }

      .scoops-add:active {
        transform: scale(0.92);
      }
    `;
    this.container.appendChild(style);
  }
}
