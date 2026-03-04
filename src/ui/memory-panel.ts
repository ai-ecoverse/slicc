/**
 * Memory Panel — displays CLAUDE.md memory files for global and group contexts.
 */

import type { VirtualFS } from '../fs/index.js';
import type { Orchestrator } from '../groups/index.js';

export class MemoryPanel {
  private container: HTMLElement;
  private bodyEl!: HTMLElement;
  private orchestrator: Orchestrator | null = null;
  private selectedGroupJid: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 5000);
  }

  setSelectedGroup(jid: string | null): void {
    this.selectedGroupJid = jid;
    this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.orchestrator) return;

    const tmp = document.createElement('div');
    tmp.className = 'memory-panel__content';

    // Global memory section
    const globalSection = document.createElement('div');
    globalSection.className = 'memory-panel__section';
    
    const globalHeader = document.createElement('div');
    globalHeader.className = 'memory-panel__section-header';
    globalHeader.textContent = 'Global Memory';
    globalSection.appendChild(globalHeader);

    const globalContent = document.createElement('div');
    globalContent.className = 'memory-panel__memory-content';
    
    try {
      const globalMemory = await this.orchestrator.getGlobalMemory();
      globalContent.textContent = globalMemory || '(empty)';
    } catch {
      globalContent.textContent = '(not available)';
    }
    globalSection.appendChild(globalContent);
    tmp.appendChild(globalSection);

    // Group memory section (if a group is selected)
    if (this.selectedGroupJid) {
      const context = this.orchestrator.getGroupContext(this.selectedGroupJid);
      const group = this.orchestrator.getGroup(this.selectedGroupJid);
      
      if (context && group) {
        const groupSection = document.createElement('div');
        groupSection.className = 'memory-panel__section';
        
        const groupHeader = document.createElement('div');
        groupHeader.className = 'memory-panel__section-header';
        groupHeader.textContent = `Group: ${group.name}`;
        groupSection.appendChild(groupHeader);

        const groupContent = document.createElement('div');
        groupContent.className = 'memory-panel__memory-content';
        
        try {
          const fs = context.getFS();
          if (fs) {
            const content = await fs.readFile('/workspace/group/CLAUDE.md', { encoding: 'utf-8' });
            groupContent.textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
          } else {
            groupContent.textContent = '(filesystem not ready)';
          }
        } catch {
          groupContent.textContent = '(no memory file yet)';
        }
        groupSection.appendChild(groupContent);
        tmp.appendChild(groupSection);
      }
    }

    // Only update if changed
    if (tmp.innerHTML !== this.bodyEl.innerHTML) {
      while (this.bodyEl.firstChild) this.bodyEl.removeChild(this.bodyEl.firstChild);
      while (tmp.firstChild) this.bodyEl.appendChild(tmp.firstChild);
    }
  }

  private render(): void {
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
    this.container.classList.add('memory-panel');

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.textContent = 'Memory';
    this.container.appendChild(header);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'memory-panel__body';
    this.container.appendChild(this.bodyEl);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
