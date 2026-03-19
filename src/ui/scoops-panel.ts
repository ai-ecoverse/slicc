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
import { type Orchestrator } from '../scoops/orchestrator.js';
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

  constructor(container: HTMLElement, callbacks: ScoopsPanelCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
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
    const scoops = [...allScoops.filter((s) => s.isCone), ...allScoops.filter((s) => !s.isCone)];
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

      // Build DOM safely
      // Colored dot indicator — uses SLICC brand palette
      const SCOOP_COLORS = ['#f000a0', '#00f0f0', '#90f000', '#15d675', '#e68619'];
      if (scoop.isCone) {
        // Cone triangle icon matching the dynamic logo
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '14');
        svg.setAttribute('viewBox', '0 0 12 14');
        svg.setAttribute('fill', '#f07000');
        svg.classList.add('scoop-icon', 'scoop-icon--cone');
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M1 0L6 14L11 0Z');
        svg.appendChild(path);
        item.appendChild(svg);
      } else {
        const iconEl = document.createElement('div');
        iconEl.className = 'scoop-icon';
        const scoopIndex = scoops.filter((s) => !s.isCone).indexOf(scoop);
        iconEl.style.background = SCOOP_COLORS[scoopIndex % SCOOP_COLORS.length];
        item.appendChild(iconEl);
      }

      const infoEl = document.createElement('div');
      infoEl.className = 'scoop-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'scoop-name';
      nameEl.textContent = scoop.assistantLabel;
      infoEl.appendChild(nameEl);

      const metaEl = document.createElement('div');
      metaEl.className = 'scoop-meta';

      const statusEl = document.createElement('span');
      statusEl.className = 'scoop-status';
      statusEl.textContent = status;
      metaEl.appendChild(statusEl);

      infoEl.appendChild(metaEl);
      item.appendChild(infoEl);

      if (!scoop.isCone) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'scoop-delete';
        deleteBtn.dataset.tooltip = 'Delete scoop';
        deleteBtn.textContent = '\u00d7';
        item.appendChild(deleteBtn);
      }

      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('scoop-delete')) {
          this.deleteScoop(scoop.jid);
        } else {
          this.selectScoop(scoop);
        }
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
    const scoop = scoops.find((s) => s.folder === folder);
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
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'scoop'
    );
  }

  /** Render the panel */
  private render(): void {
    // Build DOM safely
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);

    const panel = document.createElement('div');
    panel.className = 'scoops-panel';

    const header = document.createElement('div');
    header.className = 'scoops-header';

    const title = document.createElement('h3');
    title.textContent = 'Scoops';
    header.appendChild(title);

    const addBtn = document.createElement('button');
    addBtn.className = 'scoops-add';
    addBtn.dataset.tooltip = 'Create new scoop';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => this.showCreateDialog());
    header.appendChild(addBtn);

    panel.appendChild(header);

    const list = document.createElement('div');
    list.className = 'scoops-list';
    panel.appendChild(list);

    this.container.appendChild(panel);

    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      .scoops-panel {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--s2-bg-layer-1);
        color: var(--s2-content-default);
      }

      .scoops-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--s2-spacing-200) var(--s2-spacing-300);
        border-bottom: 1px solid var(--s2-border-subtle);
      }

      .scoops-header h3 {
        margin: 0;
        font-size: var(--s2-font-size-50);
        font-weight: 700;
        color: var(--s2-content-tertiary);
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      .scoops-add {
        width: 22px;
        height: 22px;
        border: none;
        border-radius: var(--s2-radius-pill);
        background: transparent;
        color: var(--s2-content-tertiary);
        font-size: 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background var(--s2-transition-default), color var(--s2-transition-default), transform var(--s2-transition-default);
      }

      .scoops-add:hover {
        background: var(--s2-gray-200);
        color: var(--s2-content-default);
      }

      .scoops-add:active {
        transform: scale(0.92);
      }

      .scoops-list {
        flex: 1;
        overflow-y: auto;
        padding: var(--s2-spacing-100);
      }

      .scoops-empty {
        padding: var(--s2-spacing-300);
        text-align: center;
        color: var(--s2-content-disabled);
        font-size: var(--s2-font-size-75);
      }

      .scoop-item {
        display: flex;
        align-items: center;
        gap: var(--s2-spacing-200);
        padding: var(--s2-spacing-100) var(--s2-spacing-200);
        border-radius: var(--s2-radius-default);
        cursor: pointer;
        transition: background var(--s2-transition-default);
        margin-bottom: 1px;
        position: relative;
      }

      .scoop-item:hover {
        background: var(--s2-bg-elevated);
      }

      .scoop-item.selected {
        background: var(--s2-bg-elevated);
        position: relative;
      }
      .scoop-item.selected::before {
        content: '';
        position: absolute; left: 0; top: 4px; bottom: 4px;
        width: 3px; border-radius: 0 3px 3px 0;
        background: var(--s2-accent);
      }

      .scoop-icon {
        width: 10px; height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .scoop-info {
        flex: 1;
        min-width: 0;
      }

      .scoop-name {
        font-size: var(--s2-font-size-100);
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .scoop-meta {
        display: flex;
        gap: var(--s2-spacing-100);
        margin-top: 2px;
        font-size: var(--s2-font-size-50);
        color: var(--s2-content-tertiary);
      }

      .scoop-status {
        padding: 1px 6px;
        border-radius: var(--s2-radius-pill);
        background: var(--s2-gray-200);
        font-weight: 500;
        font-size: 10px;
      }

      .scoop-item.status-ready .scoop-status {
        background: rgba(45,157,120,0.2);
        color: var(--s2-positive);
      }

      .scoop-item.status-processing .scoop-status {
        background: rgba(230,134,25,0.2);
        color: var(--s2-notice);
      }

      .scoop-item.status-error .scoop-status {
        background: rgba(227,72,80,0.2);
        color: var(--s2-negative);
      }

      .scoop-delete {
        width: 20px;
        height: 20px;
        border: none;
        border-radius: var(--s2-radius-s);
        background: transparent;
        color: var(--s2-content-disabled);
        font-size: 16px;
        cursor: pointer;
        opacity: 0;
        transition: opacity var(--s2-transition-default), background var(--s2-transition-default), color var(--s2-transition-default);
      }

      .scoop-item:hover .scoop-delete {
        opacity: 1;
      }

      .scoop-delete:hover {
        background: rgba(227,72,80,0.15);
        color: var(--s2-negative);
      }
    `;
    this.container.appendChild(style);
  }
}
