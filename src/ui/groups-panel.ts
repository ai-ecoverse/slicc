/**
 * Groups Panel - UI for managing conversation groups.
 * 
 * Provides:
 * - List of registered groups
 * - Create/delete groups
 * - Switch active group
 * - View group status
 */

import type { RegisteredGroup, GroupTabState } from '../groups/types.js';
import { Orchestrator } from '../groups/orchestrator.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('groups-panel');

export interface GroupsPanelCallbacks {
  /** Called when user selects a group */
  onGroupSelect: (group: RegisteredGroup) => void;
  /** Called when user sends a message to a group */
  onSendMessage: (groupJid: string, text: string) => void;
}

export class GroupsPanel {
  private container: HTMLElement;
  private orchestrator: Orchestrator | null = null;
  private callbacks: GroupsPanelCallbacks;
  private selectedGroupJid: string | null = null;
  private groupStatuses: Map<string, GroupTabState['status']> = new Map();

  constructor(container: HTMLElement, callbacks: GroupsPanelCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
  }

  /** Set the orchestrator instance */
  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
    this.refreshGroups();
  }

  /** Update group status */
  updateGroupStatus(jid: string, status: GroupTabState['status']): void {
    this.groupStatuses.set(jid, status);
    this.refreshGroups();
  }

  /** Refresh the group list */
  refreshGroups(): void {
    if (!this.orchestrator) return;

    const groups = this.orchestrator.getGroups();
    const listEl = this.container.querySelector('.groups-list');
    if (!listEl) return;

    listEl.innerHTML = '';

    if (groups.length === 0) {
      listEl.innerHTML = '<div class="groups-empty">No groups yet. Create one to start.</div>';
      return;
    }

    for (const group of groups) {
      const status = this.groupStatuses.get(group.jid) ?? 'inactive';
      const isSelected = group.jid === this.selectedGroupJid;

      const item = document.createElement('div');
      item.className = `group-item ${isSelected ? 'selected' : ''} status-${status}`;
      item.dataset.jid = group.jid;

      item.innerHTML = `
        <div class="group-icon">${group.isMain ? '⭐' : '💬'}</div>
        <div class="group-info">
          <div class="group-name">${this.escapeHtml(group.name)}</div>
          <div class="group-meta">
            <span class="group-status">${status}</span>
            ${group.requiresTrigger ? `<span class="group-trigger">${this.escapeHtml(group.trigger || '@Andy')}</span>` : ''}
          </div>
        </div>
        <button class="group-delete" title="Delete group">&times;</button>
      `;

      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('group-delete')) {
          this.deleteGroup(group.jid);
        } else {
          this.selectGroup(group);
        }
      });

      listEl.appendChild(item);
    }
  }

  /** Select a group */
  private selectGroup(group: RegisteredGroup): void {
    this.selectedGroupJid = group.jid;
    this.refreshGroups();
    this.callbacks.onGroupSelect(group);
  }

  /** Delete a group */
  private async deleteGroup(jid: string): Promise<void> {
    if (!this.orchestrator) return;

    const group = this.orchestrator.getGroup(jid);
    if (!group) return;

    if (group.isMain) {
      alert('Cannot delete the main group');
      return;
    }

    if (!confirm(`Delete group "${group.name}"? This cannot be undone.`)) {
      return;
    }

    await this.orchestrator.unregisterGroup(jid);
    
    if (this.selectedGroupJid === jid) {
      this.selectedGroupJid = null;
    }

    this.refreshGroups();
    log.info('Group deleted', { jid, name: group.name });
  }

  /** Show create group dialog */
  private showCreateDialog(): void {
    const name = prompt('Enter group name:');
    if (!name?.trim()) return;

    this.createGroup(name.trim());
  }

  /** Create a new group */
  async createGroup(name: string, isMain = false): Promise<RegisteredGroup> {
    if (!this.orchestrator) {
      throw new Error('Orchestrator not set');
    }

    const folder = this.sanitizeFolderName(name);
    const jid = `web_${folder}_${Date.now()}`;

    const group: RegisteredGroup = {
      jid,
      name,
      folder,
      trigger: '@Andy',
      requiresTrigger: !isMain,
      isMain,
      addedAt: new Date().toISOString(),
    };

    await this.orchestrator.registerGroup(group);
    this.refreshGroups();

    log.info('Group created', { jid, name, isMain });
    return group;
  }

  /** Sanitize a name into a valid folder name */
  private sanitizeFolderName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'group';
  }

  /** Escape HTML */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /** Render the panel */
  private render(): void {
    this.container.innerHTML = `
      <div class="groups-panel">
        <div class="groups-header">
          <h3>Groups</h3>
          <button class="groups-add" title="Create new group">+</button>
        </div>
        <div class="groups-list"></div>
      </div>
    `;

    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      .groups-panel {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #16162a;
        color: #e0e0e0;
      }

      .groups-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid #2a2a4a;
      }

      .groups-header h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }

      .groups-add {
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 4px;
        background: #e94560;
        color: white;
        font-size: 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .groups-add:hover {
        background: #ff6b8a;
      }

      .groups-list {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
      }

      .groups-empty {
        padding: 16px;
        text-align: center;
        color: #808090;
        font-size: 13px;
      }

      .group-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.15s;
        margin-bottom: 4px;
      }

      .group-item:hover {
        background: #1e1e3a;
      }

      .group-item.selected {
        background: #2a2a5a;
      }

      .group-icon {
        font-size: 20px;
        width: 32px;
        text-align: center;
      }

      .group-info {
        flex: 1;
        min-width: 0;
      }

      .group-name {
        font-size: 14px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .group-meta {
        display: flex;
        gap: 8px;
        margin-top: 2px;
        font-size: 11px;
        color: #808090;
      }

      .group-status {
        padding: 1px 6px;
        border-radius: 3px;
        background: #2a2a4a;
      }

      .group-item.status-ready .group-status {
        background: #2d5a2d;
        color: #90ee90;
      }

      .group-item.status-processing .group-status {
        background: #5a5a2d;
        color: #eeee90;
      }

      .group-item.status-error .group-status {
        background: #5a2d2d;
        color: #ee9090;
      }

      .group-trigger {
        color: #6090c0;
      }

      .group-delete {
        width: 20px;
        height: 20px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: #808090;
        font-size: 16px;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
      }

      .group-item:hover .group-delete {
        opacity: 1;
      }

      .group-delete:hover {
        background: #5a2d2d;
        color: #ee9090;
      }
    `;
    this.container.appendChild(style);

    // Event listeners
    const addBtn = this.container.querySelector('.groups-add');
    addBtn?.addEventListener('click', () => this.showCreateDialog());
  }
}
